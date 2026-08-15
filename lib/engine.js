import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SearchIndex } from "./search.js";
import { SqliteIndex } from "./sqlite-index.js";
import { resolveEmbedClient, embedDocs, vectorSearchIdx } from "./embed-manager.js";
import { recordUsage } from "./usage.js";

const LORE_CATEGORIES = ["characters", "world", "timeline", "foreshadowing", "other"];

function cleanRel(rel) {
  const p = path.normalize(String(rel)).replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  if (p === "" || p === "." || p.startsWith("..") || path.isAbsolute(p)) {
    throw new Error("dsh-tool-writing: unsafe relative path: " + String(rel));
  }
  return p;
}

function splitTerms(query) {
  return String(query)
    .split(/[\s,，、;；。！？!?：:]+/)
    .map(function (t) { return t.trim(); })
    .filter(function (t) { return t.length > 0; });
}

export function countWords(text) {
  return String(text).replace(/\s/g, "").length;
}

export class NovelEngine {
  constructor(config, credentials) {
    this.config = config || {};
    this.credentials = credentials;
    this.root = path.resolve(this.config.projectRoot || ".");
    this._idxConn = null; // 项目索引连接复用
  }

  _idx() {
    if (!this._idxConn) this._idxConn = new SqliteIndex(path.join(this.root, ".writing-index.sqlite"));
    return this._idxConn;
  }

  // 释放常驻连接（测试/插件卸载时用）
  closeIndex() {
    if (this._idxConn) {
      try { this._idxConn.close(); } catch (e) {}
      this._idxConn = null;
    }
  }

  async resolveApiKey() {
    const envName = this.config.apiKeyEnv || "DSH_WRITING_API_KEY";
    if (this.credentials && typeof this.credentials.resolve === "function") {
      try {
        const hit = await this.credentials.resolve(envName);
        if (hit && hit.value && hit.value.length > 0) return hit.value;
      } catch (e) {}
    }
    const env = process.env[envName];
    if (env && env.length > 0) return env;
    if (this.config.apiKey && this.config.apiKey.length > 0) return this.config.apiKey;
    throw new Error(
      "dsh-tool-writing: no API key. Store " + envName +
      " in the credentials store (Models page) or set it in the environment."
    );
  }

  async generate(opts) {
    opts = opts || {};
    const apiKey = await this.resolveApiKey();
    const messages = [];
    if (opts.system && opts.system.length > 0) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: opts.prompt || "" });
    // 思考档位路由：low=主模型轻思考（草稿/批量）；high/max=深度模型（拆解/审校/推演）。
    // 显式 opts.effort（官方 V4 三档 low/high/max）才携带 reasoning_effort 参数；
    // 旧调用 opts.deep:true 等价 high 但不传参数，保持原有线上行为。
    const effort = opts.effort || (opts.deep ? "high" : "low");
    const model = effort === "low"
      ? (this.config.model || "deepseek-chat")
      : (this.config.deepModel || this.config.model || "deepseek-chat");
    const body = {
      model: model,
      messages: messages,
      stream: false,
      max_tokens: opts.maxTokens || this.config.maxTokens || 4096
    };
    if (opts.effort) body.reasoning_effort = opts.effort;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.json) body.response_format = { type: "json_object" };
    const base = (this.config.baseURL || "https://api.deepseek.com") + "/chat/completions";
    const timeoutMs = opts.timeoutMs || this.config.timeoutMs || 180000;
    const doFetch = function (signal) {
      return fetch(base, {
        method: "POST",
        headers: {
          authorization: "Bearer " + apiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: signal
      });
    };
    const mkSignal = function (extra) {
      const t = AbortSignal.timeout(timeoutMs);
      return extra ? AbortSignal.any([extra, t]) : t;
    };
    const t0 = Date.now();
    let res;
    try {
      res = await doFetch(mkSignal(opts.signal));
    } catch (e) {
      // 用户主动取消不重试；网络错误/超时重试一次（全新超时）
      if (opts.signal && opts.signal.aborted) throw e;
      res = await doFetch(AbortSignal.timeout(timeoutMs));
    }
    if (!res.ok) {
      let message = "DeepSeek API error (HTTP " + res.status + ")";
      try {
        const data = await res.json();
        if (data && data.error && data.error.message) message = data.error.message;
      } catch (e) {}
      recordUsage({ model, effort, ok: false, error: message, durationMs: Date.now() - t0 });
      throw new Error(message);
    }
    const data = await res.json();
    const u = data && data.usage ? data.usage : {};
    recordUsage({ model, effort, ok: true, promptTokens: u.prompt_tokens || 0, completionTokens: u.completion_tokens || 0, cacheHit: u.prompt_cache_hit_tokens || 0, cacheMiss: u.prompt_cache_miss_tokens || 0, durationMs: Date.now() - t0 });
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : "";
    return typeof content === "string" ? content : "";
  }

  async generateMany(tasks, opts) {
    opts = opts || {};
    if (!tasks || tasks.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.concurrency || this.config.maxConcurrency || 4, tasks.length));
    const results = new Array(tasks.length);
    let next = 0;
    const worker = async function () {
      while (true) {
        const i = next++;
        if (i >= tasks.length) return;
        results[i] = await this.generate(Object.assign({}, tasks[i], { signal: opts.signal }));
      }
    }.bind(this);
    await Promise.all(Array.from({ length: limit }, worker));
    return results;
  }

  abs(rel) {
    return path.join(this.root, cleanRel(rel));
  }

  // 非破坏式铺骨架：只创建缺失的目录/文件，绝不覆盖已有内容（幂等）
  async scaffold(opts) {
    const created = [];
    const dirs = [
      "chapters", "outline", "research", "export",
      "lore/characters", "lore/world", "lore/timeline", "lore/foreshadowing", "lore/other"
    ];
    for (const d of dirs) {
      try { await fs.access(path.join(this.root, d)); }
      catch (e) { await fs.mkdir(path.join(this.root, d), { recursive: true }); created.push(d + "/"); }
    }
    const guides = {
      "chapters/README.md": "# chapters/ 章节仓\n\n- 章节文件：分卷用「卷01-风起/001-标题.md」，平铺用「ch001.md」（自动编号）\n- INDEX.md 是自动生成的活目录（章节/字数/状态/摘要），由 novel_sync 维护，不要手改\n- 章节状态机：draft（草稿）→ polished（已润色）→ final（定稿），记录在 novel.json 台账\n- 导出成品用 novel_export，输出到 export/",
      "outline/README.md": "# outline/ 大纲区\n\n- main.md：主线（阶段节奏 + 爽点排布）\n- volumes/*.md：分卷大纲\n- chapters/*.md：章节细纲（可用 novel_outline level=chapter 批量生成）",
      "research/README.md": "# research/ 考据区\n\n- 由 novel_research 自动归纳的资料笔记\n- 审校发现的问题也放这里（novel_review）",
      "export/README.md": "# export/ 导出区\n\n- novel_export 的成品（合并 Markdown / TXT）输出到这里",
      "lore/README.md": "# lore/ 设定总库（五大类）\n\n- characters/：人物卡（front-matter 元数据 + 内嵌演化史）\n- world/：世界观/势力/力量体系\n- timeline/：时间线事件（带 chapterRef）\n- foreshadowing/：伏笔（带 resolvedIn，登记于 foreshadowing.json）\n- other/：plot-log.md 情节日志、style-profile.md 风格指纹等",
      "lore/other/plot-log.md": "# 情节日志\n\n> novel_sync 每次章末编排会自动登记章节摘要。\n"
    };
    for (const rel of Object.keys(guides)) {
      try { await fs.access(this.abs(rel)); }
      catch (e) { await this.writeText(rel, guides[rel]); created.push(rel); }
    }
    let manifest = null;
    try { manifest = await this.readManifest(); }
    catch (e) {
      manifest = {
        title: (opts && opts.title) || "未命名",
        genre: "", synopsis: "", protagonist: "", cheat: "",
        chapters: [], volumes: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      await this.writeManifest(manifest);
      created.push("novel.json");
    }
    for (const rel of ["foreshadowing.json", "evolution.json"]) {
      try { await fs.access(this.abs(rel)); }
      catch (e) { await this.writeText(rel, JSON.stringify({ entries: [] }, null, 2) + "\n"); created.push(rel); }
    }
    try { await fs.access(this.abs("chapters/INDEX.md")); }
    catch (e) { await this.rebuildCatalog(); created.push("chapters/INDEX.md"); }
    return { created: created, manifest: manifest };
  }

  // 重建活目录：从台账生成 chapters/INDEX.md（分卷分组 + 字数 + 状态 + 摘要）
  // 台账移除章节（写正文删章用）：删文件 + 台账条目 + 刷新活目录
  async removeChapter(chapterId) {
    let manifest = {};
    try { manifest = await this.readManifest(); } catch (e) { return { removed: 0, reason: "no-manifest" }; }
    const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
    const c = chapters.find(function (x) { return x.id === chapterId; });
    if (!c) return { removed: 0, reason: "not-found" };
    try { await this.deleteFile(c.path); } catch (e) {}
    manifest.chapters = chapters.filter(function (x) { return x.id !== chapterId; });
    if (manifest.lastChapter === chapterId) manifest.lastChapter = chapters.length ? chapters[chapters.length - 1].id : "";
    await this.writeManifest(manifest);
    await this.rebuildCatalog();
    return { removed: 1, id: chapterId };
  }

  async rebuildCatalog() {
    let manifest = {};
    try { manifest = await this.readManifest(); } catch (e) {}
    const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
    const lines = [
      "# 目录（自动生成，由 novel_sync 维护）",
      "",
      "> 共 " + chapters.length + " 章 · 更新于 " + new Date().toISOString(),
      ""
    ];
    const byVol = {};
    const volOrder = [];
    for (const c of chapters) {
      const v = c.volume || "未分卷";
      if (!byVol[v]) { byVol[v] = []; volOrder.push(v); }
      byVol[v].push(c);
    }
    for (const v of volOrder) {
      lines.push("## " + v);
      lines.push("");
      lines.push("| # | 章节 | 字数 | 状态 | 摘要 |");
      lines.push("|---|---|---|---|---|");
      for (const c of byVol[v]) {
        const summary = String(c.summary || "").replace(/\n/g, " ").slice(0, 40);
        lines.push("| " + c.id + " | " + (c.title || "（无标题）") + " | " + (c.words || 0) + " | " + (c.status || "draft") + " | " + summary + " |");
      }
      lines.push("");
    }
    if (!volOrder.length) lines.push("（暂无章节，写完第一章后这里会出现自动目录）");
    await this.writeText("chapters/INDEX.md", lines.join("\n") + "\n");
    return { chapters: chapters.length, volumes: volOrder.length };
  }

  async ensureProject(meta) {
    await this.scaffold(meta);
    let manifest = {};
    try { manifest = await this.readManifest(); } catch (e) {}
    const next = Object.assign({}, manifest, meta || {}, { updatedAt: new Date().toISOString() });
    await this.writeManifest(next);
    return next;
  }

  async readManifest() {
    return JSON.parse(await fs.readFile(path.join(this.root, "novel.json"), "utf8"));
  }

  async writeManifest(obj) {
    await fs.writeFile(path.join(this.root, "novel.json"), JSON.stringify(obj, null, 2) + "\n", "utf8");
  }

  async readText(rel) {
    return fs.readFile(this.abs(rel), "utf8");
  }

  async writeText(rel, content) {
    const abs = this.abs(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return abs;
  }

  async deleteFile(rel) {
    await fs.unlink(this.abs(rel));
  }

  async listFiles(rel) {
    const abs = this.abs(rel);
    const out = [];
    async function walk(dir) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (/\.(md|txt|json)$/i.test(e.name)) out.push(path.relative(abs, full).split(path.sep).join("/"));
      }
    }
    await walk(abs);
    return out.sort();
  }

  _snippet(text, query) {
    const s = String(text || "");
    const chars = Array.from(new Set(String(query).split("")));
    let at = -1;
    for (const c of chars) { const i = s.indexOf(c); if (i !== -1 && (at === -1 || i < at)) at = i; }
    if (at === -1) return s.slice(0, 160);
    const start = at > 60 ? at - 60 : 0;
    return s.slice(start, start + 160);
  }

  async _indexMetaFile() { return path.join(this.root, ".writing-index.meta.json"); }
  async _indexDbFile() { return path.join(this.root, ".writing-index.sqlite"); }

  async _indexFingerprint() {
    const roots = ["lore", "outline", "chapters"];
    const parts = [];
    for (const root of roots) {
      const files = await this.listFiles(root);
      for (const rel of files) {
        const fullRel = root + "/" + rel;
        try {
          const st = await fs.stat(this.abs(fullRel));
          parts.push(fullRel + ":" + Math.round(st.mtimeMs));
        } catch (e) {}
      }
    }
    return parts.join("|");
  }

  async _gatherIndexDocs() {
    const docs = [];
    const roots = ["lore", "outline", "chapters"];
    for (const root of roots) {
      const files = await this.listFiles(root);
      for (const rel of files) {
        const fullRel = root + "/" + rel;
        let text;
        try { text = await this.readText(fullRel); } catch (e) { continue; }
        docs.push({ id: fullRel, ref: fullRel, title: rel, words: text.replace(/\s/g, "").length, content: text, meta: {} });
      }
    }
    return docs;
  }

  async _ensureIndex() {
    let fresh = false;
    try {
      const meta = JSON.parse(await fs.readFile(await this._indexMetaFile(), "utf8"));
      fresh = meta.fingerprint === (await this._indexFingerprint());
    } catch (e) { fresh = false; }
    if (!fresh) await this.buildProjectIndex();
  }

  // 增量索引：内容未变的文档保留向量；内容变化自动作废旧向量（等待重嵌）
  async buildProjectIndex() {
    const docs = await this._gatherIndexDocs();
    const idx = this._idx();
    const wanted = new Set(docs.map(function (d) { return d.id; }));
    for (const d of docs) idx.addDoc(d);
    for (const id of idx.allDocIds()) {
      if (!wanted.has(id)) idx.removeDoc(id);
    }
    await fs.writeFile(await this._indexMetaFile(), JSON.stringify({ fingerprint: await this._indexFingerprint(), generatedAt: Date.now() }) + "\n", "utf8");
  }

  // 纯向量检索；无 key 或尚无向量时返回 null（调用方走字面兜底）
  async vectorSearch(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 8;
    await this._ensureIndex();
    const client = await resolveEmbedClient(this.config, this.credentials);
    if (!client) return null;
    const idx = this._idx();
    let hits = null;
    try { hits = await vectorSearchIdx(idx, query, limit, client); } catch (e) { hits = null; }
    if (!hits) return null;
    return hits.map(function (h) {
      return { rel: h.ref, score: Math.round(h.score * 1000) / 1000, snippet: h.text.slice(0, 200) };
    });
  }

  // 惰性回填：为没有向量的文档补嵌（每次最多 cap 个文档，可反复调用直至完成）
  async embedMissing(opts) {
    opts = opts || {};
    await this._ensureIndex();
    const client = await resolveEmbedClient(this.config, this.credentials);
    if (!client) return { embedded: 0, chunks: 0, skipped: 0, failed: 0, reason: "no-key" };
    const idx = this._idx();
    const missing = idx.missingVectorDocs();
    const cap = Math.max(1, opts.cap || 15);
    const stats = await embedDocs(idx, missing.slice(0, cap), client, {});
    const left = idx.missingVectorDocs().length;
    stats.remaining = left;
    return stats;
  }

  async search(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 8;
    await this._ensureIndex();
    const idx = this._idx();
    const docs = idx.query(query, { limit: limit });
    const out = [];
    for (const d of docs) {
      out.push({ rel: d.ref, words: d.words, snippet: this._snippet(d.content, query) });
    }
    return out;
  }

  async recall(query, opts) {
    return this.search(query, opts);
  }
}
