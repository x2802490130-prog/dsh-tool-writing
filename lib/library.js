import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SearchIndex } from "./search.js";
import { SqliteIndex } from "./sqlite-index.js";
import { parseEpub } from "./epub.js";
import { resolveEmbedClient, embedDocs, vectorSearchIdx } from "./embed-manager.js";
import { ConceptIndex } from "./concept-index.js";

const CHAPTER_HEAD_RE = /^[\s\u3000]*(第[0-9零一二三四五六七八九十百千万两]+[章卷节回集部]|Chapter\s+\d+)/i;

function decodeText(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder("gb18030").decode(buf); }
}

function splitChapters(text) {
  const lines = String(text || "").split(/\r?\n/);
  const chapters = [];
  let current = null;
  for (const line of lines) {
    if (CHAPTER_HEAD_RE.test(line)) {
      if (current && current.content.trim()) chapters.push(current);
      current = { title: line.trim().slice(0, 80), content: "" };
      continue;
    }
    if (current === null) {
      if (line.trim()) current = { title: "前言", content: "" };
      else continue;
    }
    current.content += line + "\n";
  }
  if (current && current.content.trim()) chapters.push(current);
  if (chapters.length === 0) chapters.push({ title: "全文", content: text });
  return chapters;
}

function slugify(title) {
  const s = String(title || "").trim().replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 30).replace(/^-+|-+$/g, "");
  return s || "novel";
}

function countWords(text) { return String(text || "").replace(/\s/g, "").length; }

function fileToChapters(buf, filename) {
  if (/\.epub$/i.test(filename)) return parseEpub(buf);
  return { title: "", author: "", chapters: splitChapters(decodeText(buf)) };
}

function snippet(text, query, radius) {
  const s = String(text || "");
  const r = radius || 80;
  const terms = Array.from(new Set(String(query).split("")));
  let idx = -1;
  for (const t of terms) {
    const i = s.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) return s.slice(0, r * 2);
  const start = idx > r ? idx - r : 0;
  return s.slice(start, start + r * 2);
}

export class Library {
  constructor(root, opts) {
    this.root = path.resolve(root);
    this.index = new SearchIndex();
    this.indexLoaded = false;
    this.embedOpts = opts || {};
    this._idxConn = null; // 索引连接复用：避免每次检索都开/关 SQLite
    this._conceptConn = null; // LLM 概念索引（无 embedding key 时兜底）
  }

  _conceptIdx() {
    if (!this._conceptConn) this._conceptConn = new ConceptIndex(path.join(this.root, ".writing-concepts.json"), (this.embedOpts && this.embedOpts.engine) || null);
    return this._conceptConn;
  }

  _idx() {
    if (!this._idxConn) this._idxConn = new SqliteIndex(path.join(this.root, ".index.sqlite"));
    return this._idxConn;
  }

  // 释放常驻连接（测试/插件卸载时用；Windows 上连接开着会锁住索引文件）
  closeIndex() {
    if (this._idxConn) {
      try { this._idxConn.close(); } catch (e) {}
      this._idxConn = null;
    }
  }

  async ensure() { await fs.mkdir(this.root, { recursive: true }); }

  async catalog() {
    try { return JSON.parse(await fs.readFile(path.join(this.root, "catalog.json"), "utf8")); }
    catch (e) { return { entries: {} }; }
  }

  async saveCatalog(cat) {
    await fs.writeFile(path.join(this.root, "catalog.json"), JSON.stringify(cat, null, 2) + "\n", "utf8");
  }

  async _gatherTextFiles(dir) {
    const out = [];
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await this._gatherTextFiles(full)));
      else if (/\.(txt|md|markdown|epub)$/i.test(e.name)) out.push(full);
    }
    return out.sort();
  }

  async import(opts) {
    await this.ensure();
    const abs = path.resolve(opts.source);
    const st = await fs.stat(abs);
    const files = st.isDirectory() ? await this._gatherTextFiles(abs) : [abs];
    if (files.length === 0) throw new Error("未找到可导入的文件（.txt/.md/.epub）");
    const id = slugify(opts.title || path.basename(abs)) + "-" + Date.now().toString(36);
    const novelDir = path.join(this.root, id);
    await fs.mkdir(path.join(novelDir, "chapters"), { recursive: true });
    const chapterFiles = [];
    let total = 0;
    let n = 0;
    let epubTitle = "";
    let epubAuthor = "";
    for (const f of files) {
      const buf = await fs.readFile(f);
      const parsed = fileToChapters(buf, f);
      if (parsed.title) epubTitle = epubTitle || parsed.title;
      if (parsed.author) epubAuthor = epubAuthor || parsed.author;
      for (const c of parsed.chapters) {
        n++;
        const name = "ch" + String(n).padStart(4, "0") + ".txt";
        await fs.writeFile(path.join(novelDir, "chapters", name), c.content, "utf8");
        const w = countWords(c.content);
        total += w;
        chapterFiles.push({ file: name, title: c.title, words: w });
      }
    }
    const meta = {
      id: id,
      title: opts.title || epubTitle || path.basename(abs),
      author: opts.author || epubAuthor || "",
      genre: opts.genre || "",
      tags: opts.tags || [],
      source: abs,
      chapters: chapterFiles,
      words: total,
      importedAt: new Date().toISOString()
    };
    await fs.writeFile(path.join(novelDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
    const cat = await this.catalog();
    cat.entries[id] = { id: id, title: meta.title, author: meta.author, genre: meta.genre, tags: meta.tags, chapters: chapterFiles.length, words: total, importedAt: meta.importedAt };
    await this.saveCatalog(cat);
    await this._incrementalAdd(id);
    let embedStats = null;
    if (opts.embed === "full") {
      try { embedStats = await this.embedNovel(id); } catch (e) { embedStats = { error: String((e && e.message) || e) }; }
    }
    meta.embedStats = embedStats;
    return meta;
  }

  async list() {
    const cat = await this.catalog();
    return Object.values(cat.entries).sort(function (a, b) { return String(a.title).localeCompare(String(b.title), "zh"); });
  }

  async read(id, chapter) {
    const cat = await this.catalog();
    const entry = cat.entries[id];
    if (!entry) throw new Error("书库中不存在：" + id);
    const meta = JSON.parse(await fs.readFile(path.join(this.root, id, "meta.json"), "utf8"));
    if (chapter === undefined || chapter === null) {
      return { meta: meta };
    }
    const ch = meta.chapters.find(function (c) { return c.file === chapter || c.title === chapter; });
    if (!ch) throw new Error("章节不存在：" + chapter);
    const text = await fs.readFile(path.join(this.root, id, "chapters", ch.file), "utf8");
    return { meta: meta, chapter: ch, text: text };
  }

  async remove(id) {
    const cat = await this.catalog();
    if (!cat.entries[id]) throw new Error("书库中不存在：" + id);
    await fs.rm(path.join(this.root, id), { recursive: true, force: true });
    delete cat.entries[id];
    await this.saveCatalog(cat);
    await this._incrementalRemove(id);
    return { removed: id };
  }

  async _dbFile() { return path.join(this.root, ".index.sqlite"); }

  async _dbExists() {
    try { await fs.stat(await this._dbFile()); return true; }
    catch (e) { return false; }
  }

  async _incrementalAdd(id) {
    if (!(await this._dbExists())) return;
    const meta = JSON.parse(await fs.readFile(path.join(this.root, id, "meta.json"), "utf8"));
    const idx = this._idx();
    for (const ch of meta.chapters || []) {
      let text;
      try { text = await fs.readFile(path.join(this.root, id, "chapters", ch.file), "utf8"); } catch (e) { continue; }
      idx.addDoc({ id: id + ":" + ch.file, ref: id, title: meta.title, words: ch.words, content: text, meta: { file: ch.file, chapterTitle: ch.title } });
    }
  }

  async _incrementalRemove(id) {
    if (!(await this._dbExists())) return;
    const idx = this._idx();
    const ids = idx.docIdsByRef(id);
    for (const did of ids) idx.removeDoc(did);
  }

  async reindex() {
    await this.ensure();
    const cat = await this.catalog();
    // 快照现有向量：内容未变的文档重建后直接恢复，避免全量重嵌
    let snap = null;
    if (await this._dbExists()) {
      const old = this._idx();
      snap = {};
      for (const v of old.allVectors()) {
        const d = old.getDoc(v.docId);
        if (d) {
          const bucket = (snap[v.docId] = snap[v.docId] || { content: d.content, entries: [] });
          bucket.entries.push({ idx: v.chunkIdx, text: v.text, vec: v.vec });
        }
      }
    }
    const idx = this._idx();
    const docs = [];
    for (const id of Object.keys(cat.entries || {})) {
      let meta;
      try { meta = JSON.parse(await fs.readFile(path.join(this.root, id, "meta.json"), "utf8")); } catch (e) { continue; }
      for (const ch of meta.chapters || []) {
        let text;
        try { text = await fs.readFile(path.join(this.root, id, "chapters", ch.file), "utf8"); } catch (e) { continue; }
        docs.push({ id: id + ":" + ch.file, ref: id, title: meta.title, words: ch.words, content: text, meta: { file: ch.file, chapterTitle: ch.title } });
      }
    }
    idx.rebuild(docs);
    if (snap) {
      for (const docId of Object.keys(snap)) {
        const d = idx.getDoc(docId);
        if (d && d.content === snap[docId].content) idx.setVectors(docId, snap[docId].entries);
      }
    }
  }

  async _embedClient() {
    return resolveEmbedClient(this.embedOpts.config, this.embedOpts.credentials);
  }

  async embedNovel(id, opts) {
    const cat = await this.catalog();
    if (!cat.entries[id]) throw new Error("书库中不存在：" + id);
    // 索引不存在时先建全文索引，否则向量挂不到 docs 上
    if (!(await this._dbExists())) await this.reindex();
    const meta = JSON.parse(await fs.readFile(path.join(this.root, id, "meta.json"), "utf8"));
    const docs = [];
    for (const ch of meta.chapters || []) {
      let text;
      try { text = await fs.readFile(path.join(this.root, id, "chapters", ch.file), "utf8"); } catch (e) { continue; }
      docs.push({ id: id + ":" + ch.file, content: text, title: ch.title || "", ref: id });
    }
    const client = await this._embedClient();
    if (!client) {
      // 无 embedding key：DeepSeek LLM 概念索引兜底
      const ci = this._conceptIdx();
      if (!ci.engine) return { embedded: 0, chunks: 0, skipped: 0, failed: 0, error: "无 embedding key（DASHSCOPE_API_KEY），仅字面检索" };
      const stats = await ci.buildDocs(docs, opts || {});
      stats.reason = "llm-concepts";
      return stats;
    }
    const idx = this._idx();
    const stats = await embedDocs(idx, docs, client, opts || {});
    if (stats.embedded === 0 && stats.failed > 0) {
      // 稠密嵌入失败：降级 DeepSeek LLM 概念索引
      const ci = this._conceptIdx();
      if (ci.engine) {
        const cs = await ci.buildDocs(docs, opts || {});
        cs.chunks = 0;
        cs.reason = "llm-concepts-fallback";
        return cs;
      }
    }
    return stats;
  }

  async embedAll(opts) {
    const cat = await this.catalog();
    const total = { embedded: 0, chunks: 0, skipped: 0, failed: 0, novels: 0 };
    for (const id of Object.keys(cat.entries || {})) {
      try {
        const s = await this.embedNovel(id, opts);
        total.embedded += s.embedded || 0;
        total.chunks += s.chunks || 0;
        total.skipped += s.skipped || 0;
        total.failed += s.failed || 0;
        if (s.error) total.error = s.error;
        total.novels++;
      } catch (e) {}
    }
    return total;
  }

  async embedMissing(opts) {
    opts = opts || {};
    if (!(await this._dbExists())) return { embedded: 0, chunks: 0, skipped: 0, failed: 0, reason: "no-index" };
    const client = await this._embedClient();
    if (!client) return { embedded: 0, chunks: 0, skipped: 0, failed: 0, reason: "no-key" };
    const idx = this._idx();
    const missing = idx.missingVectorDocs();
    const cap = Math.max(1, opts.cap || 15);
    const stats = await embedDocs(idx, missing.slice(0, cap), client, {});
    return stats;
  }

  async vectorSearch(query, limit) {
    const n = limit || 6;
    if (!(await this._dbExists())) await this.reindex();
    const client = await this._embedClient();
    if (!client) {
      // 无 embedding key：概念索引兜底
      const ci = this._conceptIdx();
      if (!ci.engine) return null;
      const chits = await ci.query(query, n);
      if (!chits.length) return null;
      return {
        query: query,
        total: chits.length,
        mode: "concepts",
        results: chits.map(function (h) {
          return { novelId: h.ref, novelTitle: h.title, score: h.score, snippet: h.text.slice(0, 160), matched: h.matched };
        })
      };
    }
    const idx = this._idx();
    let hits = null;
    try { hits = await vectorSearchIdx(idx, query, n, client); } catch (e) { hits = null; }
    if (!hits) {
      const ci = this._conceptIdx();
      if (ci.engine) {
        const chits = await ci.query(query, n);
        if (chits.length) {
          return {
            query: query,
            total: chits.length,
            mode: "concepts",
            results: chits.map(function (h) {
              return { novelId: h.ref, novelTitle: h.title, score: h.score, snippet: h.text.slice(0, 160), matched: h.matched };
            })
          };
        }
      }
      return null;
    }
    return {
      query: query,
      total: hits.length,
      results: hits.map(function (h) {
        return { novelId: h.ref, novelTitle: h.title, chunkIdx: h.chunkIdx, score: Math.round(h.score * 1000) / 1000, snippet: snippet(h.text, query, 80) };
      })
    };
  }

  // —— 拆解骨架：每本书一套精细拆解卡（analysis/） ——
  analysisDir(novelId) {
    return path.join(this.root, novelId, "analysis");
  }

  async scaffoldAnalysis(novelId) {
    const cat = await this.catalog();
    if (!cat.entries[novelId]) throw new Error("书库中不存在：" + novelId);
    const dir = this.analysisDir(novelId);
    await fs.mkdir(path.join(dir, "蒸馏"), { recursive: true });
    const cards = {
      "00-总览.md": "# 总览（自动生成）\n\n> novel_library_analyze 拆解后自动维护：一句话定位、核心卖点、目标读者。\n",
      "01-人物.md": "# 人物拆解\n\n> 按「批次」追加：主要人物、关系网、动机弧光。\n",
      "02-世界观.md": "# 世界观拆解\n\n> 力量体系、势力格局、规则、地理。\n",
      "03-情节骨架.md": "# 情节骨架\n\n> 卷级梗概、关键转折、高潮与钩子。\n",
      "04-爽点与套路.md": "# 爽点与套路\n\n> 打脸/升级/收获节奏、金手指用法、读者情绪设计。\n",
      "05-风格.md": "# 风格拆解\n\n> 叙事视角、节奏、文风特征、对话风格。\n",
      "06-金句素材.md": "# 金句素材\n\n> 可直接借鉴/化用的名场面与金句（注意版权，仅学习拆解）。\n",
      "蒸馏/README.md": "# 蒸馏笔记\n\n> novel_distill scope=library 的产物落在这里。\n"
    };
    const created = [];
    for (const rel of Object.keys(cards)) {
      const full = path.join(dir, rel);
      try { await fs.access(full); }
      catch (e) { await fs.writeFile(full, cards[rel], "utf8"); created.push(rel); }
    }
    try { await fs.access(path.join(dir, "状态.json")); }
    catch (e) { await this.saveAnalysisStatus(novelId, { done: 0, total: 0, lastBatchAt: null }); created.push("状态.json"); }
    return { dir: dir, created: created };
  }

  async readAnalysis(novelId, rel) {
    const safe = String(rel).replace(/\.\.?[/\\]/g, "");
    return fs.readFile(path.join(this.analysisDir(novelId), safe), "utf8");
  }

  async writeAnalysis(novelId, rel, content) {
    const safe = String(rel).replace(/\.\.?[/\\]/g, "");
    const full = path.join(this.analysisDir(novelId), safe);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    return full;
  }

  async analysisStatus(novelId) {
    try { return JSON.parse(await fs.readFile(path.join(this.analysisDir(novelId), "状态.json"), "utf8")); }
    catch (e) { return { done: 0, total: 0, lastBatchAt: null }; }
  }

  async saveAnalysisStatus(novelId, obj) {
    await fs.writeFile(path.join(this.analysisDir(novelId), "状态.json"), JSON.stringify(obj, null, 2) + "\n", "utf8");
  }

  async search(q, opts) {
    opts = opts || {};
    const limit = opts.limit || 10;
    if (!(await this._dbExists())) await this.reindex();
    const idx = this._idx();
    const docs = idx.query(q, { limit: limit });
    const out = [];
    for (const d of docs) {
      out.push({
        novelId: d.ref,
        novelTitle: d.title,
        chapterFile: (d.meta && d.meta.file) || "",
        chapterTitle: (d.meta && d.meta.chapterTitle) || "",
        words: d.words,
        snippet: snippet(d.content, q, 90)
      });
    }
    return { query: q, total: docs.length, results: out };
  }
}
