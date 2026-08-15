import { defineTool } from "@deepseek-ai/dsh-tools";
import { countWords } from "./engine.js";
import { report as usageReport } from "./usage.js";
import { planLoad, planSave, planView } from "./plan.js";
import { SqliteIndex } from "./sqlite-index.js";

export { splitFrontMatter, renderCard, writeLoreCard, appendEvolutionToCard, gatherContext };

const TEXT_OUTPUT = {
  schema: { type: "string" },
  render: function (_args, value) {
    return [{ type: "text", text: String(value == null ? "" : value) }];
  }
};

function preview(text, n) {
  const s = String(text || "").trim();
  const max = n || 300;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function gatherContext(engine, opts) {
  opts = opts || {};
  // 分层上下文：minimal（写正文，省 token 提速）/ standard（默认）/ full（审校/推演，全量）
  const level = opts.level || "standard";
  const parts = [];
  let manifest = null;
  try { manifest = await engine.readManifest(); } catch (e) {}
  if (manifest) {
    parts.push("【作品信息】");
    parts.push("书名：" + (manifest.title || ""));
    parts.push("简介：" + (manifest.synopsis || ""));
    parts.push("题材：" + (manifest.genre || ""));
    parts.push("主角：" + (manifest.protagonist || ""));
    parts.push("核心设定/金手指：" + (manifest.cheat || ""));
  }
  if (opts.lore !== false) {
    const files = await engine.listFiles("lore");
    const systemFiles = ["other/style-profile.md", "other/plot-log.md", "other/inbox.md", "other/conflicts.md"];
    const cards = files.filter(function (f) { return systemFiles.indexOf(f) < 0 && f.indexOf("README") < 0; });
    const maxCards = level === "minimal" ? 20 : level === "standard" ? 30 : cards.length;
    const head = level === "minimal" ? 300 : level === "standard" ? 800 : 0;
    if (cards.length) {
      parts.push("");
      parts.push(level === "full" ? "【已有设定】" : "【设定摘要（卡片截取头部，细节用 novel_lore get 查看）】");
      for (const f of cards.slice(0, maxCards)) {
        try {
          let t = await engine.readText("lore/" + f);
          if (head) t = splitFrontMatter(t).body.slice(0, head);
          parts.push("--- " + f + " ---\n" + t);
        } catch (e) {}
      }
    }
    if (level === "full") {
      try {
        const log = await engine.readText("lore/other/plot-log.md");
        parts.push("", "【情节日志（尾部）】", log.slice(-4000));
      } catch (e) {}
    }
  }
  if (opts.outline !== false) {
    const files = await engine.listFiles("outline");
    let pick;
    if (level === "minimal") {
      const seen = new Set();
      pick = [];
      for (const f of files.filter(function (x) { return x.indexOf("main") >= 0; })) { seen.add(f); pick.push(f); }
      for (const f of files.slice(-2)) { if (!seen.has(f)) pick.push(f); }
      pick = pick.slice(0, 3);
    } else {
      pick = files.slice(0, 20);
    }
    if (pick.length) {
      parts.push("");
      parts.push("【已有大纲】");
      for (const f of pick) {
        try {
          let t = await engine.readText("outline/" + f);
          if (level !== "full") t = t.slice(0, 2000);
          parts.push("--- " + f + " ---\n" + t);
        } catch (e) {}
      }
    }
  }
  // 一致性注入：未回收伏笔 + 最近演化（写正文时自动提醒，防写回旧状态）
  try {
    const fore = JSON.parse(await engine.readText("foreshadowing.json"));
    const un = (fore.entries || []).filter(function (x) { return !x.resolvedIn; });
    if (un.length) parts.push("", "【未回收伏笔（写正文时注意回收或铺垫）】", un.slice(0, 10).map(function (x) { return "- " + x.name + (x.plantedIn ? "（埋于 " + x.plantedIn + "）" : ""); }).join("\n"));
  } catch (e) {}
  try {
    const evo = JSON.parse(await engine.readText("evolution.json"));
    const recent = (evo.entries || []).slice(-5);
    if (recent.length) parts.push("", "【最近演化（人物/设定最新状态，勿写回旧状态）】", recent.map(function (x) { return "- " + x.subject + "【" + x.dimension + "】" + (x.from ? x.from + " → " : "") + x.to + (x.chapterId ? " @" + x.chapterId : ""); }).join("\n"));
  } catch (e) {}
  if (opts.recentChapters) {
    const files = (await engine.listFiles("chapters")).sort().slice(-(opts.recentChapters));
    for (const f of files) {
      try {
        const t = await engine.readText("chapters/" + f);
        parts.push("");
        parts.push("【前文 " + f + "（结尾）】\n" + t.slice(-3000));
      } catch (e) {}
    }
  }
  try {
    const style = await engine.readText("lore/other/style-profile.md");
    if (style && style.trim()) {
      parts.push("");
      parts.push("【作者风格指纹（写作时严格遵守）】");
      parts.push(style);
    }
  } catch (e) {}
  return parts.join("\n");
}

async function recordChapter(engine, id, title, words, relPath, volume, extra) {
  let manifest = {};
  try { manifest = await engine.readManifest(); } catch (e) {}
  const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
  const prev = chapters.find(function (c) { return c.id === id; });
  const entry = {
    id: id, title: title || "", words: words, path: relPath,
    updatedAt: new Date().toISOString(),
    status: (prev && prev.status) || ((extra && extra.status) || "draft"),
    summary: (prev && prev.summary) || ""
  };
  if (volume) entry.volume = volume;
  const idx = chapters.findIndex(function (c) { return c.id === id; });
  if (idx >= 0) chapters[idx] = entry; else chapters.push(entry);
  manifest.chapters = chapters;
  manifest.lastChapter = id;
  await engine.writeManifest(manifest);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeName(s) {
  return String(s || "").trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 40) || "未分卷";
}

function parseItems(text) {
  const s = String(text || "").trim();
  let t = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const obj = JSON.parse(t);
    const items = obj.items || obj;
    return Array.isArray(items) ? items.filter(function (x) { return x && (x.name || x.subject); }) : [];
  } catch (e) {}
  const m = t.match(/[\{\[][\s\S]*[\}\]]/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      const items = obj.items || obj;
      return Array.isArray(items) ? items.filter(function (x) { return x && (x.name || x.subject); }) : [];
    } catch (e2) {}
  }
  return [];
}

function splitFrontMatter(text) {
  const s = String(text || "");
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: null, body: s };
  return { fm: m[1], body: s.slice(m[0].length) };
}

// 设定卡渲染：front-matter 元数据（subject/category/updatedAt/chapterRef/source/confidence）+ 正文
function renderCard(subject, category, body, chapterRef, extra) {
  extra = extra || {};
  const meta = ["subject: " + subject, "category: " + category, "updatedAt: " + new Date().toISOString()];
  if (chapterRef) meta.push("chapterRef: " + chapterRef);
  if (extra.source) meta.push("source: " + String(extra.source).replace(/\r?\n/g, " "));
  if (extra.confidence) meta.push("confidence: " + extra.confidence);
  return "---\n" + meta.join("\n") + "\n---\n\n" + String(body || "").trim() + "\n";
}

// 写设定卡：保留历史正文、刷新元数据；卡片即档案
async function writeLoreCard(engine, cat, name, summary, opts) {
  opts = opts || {};
  const rel = "lore/" + cat + "/" + safeName(name || "条目") + ".md";
  let existing = "";
  try { existing = await engine.readText(rel); } catch (e) { existing = ""; }
  const parts = splitFrontMatter(existing);
  const newBody = (parts.body.trim() ? parts.body.trim() + "\n\n" : "") + String(summary || "").trim();
  await engine.writeText(rel, renderCard(name, cat, newBody, opts.chapterRef || "", opts.extra));
  return rel;
}

// 把演化记录内嵌到对应设定卡的「演化史」段（卡片即演化档案）
async function appendEvolutionToCard(engine, item) {
  const subject = String(item.subject || "").trim();
  if (!subject) return null;
  const name = safeName(subject);
  for (const cat of ["characters", "world"]) {
    const rel = "lore/" + cat + "/" + name + ".md";
    let existing = "";
    try { existing = await engine.readText(rel); } catch (e) { continue; }
    const line = "- " + (item.chapterId ? "@" + item.chapterId + " " : "") + "【" + (item.dimension || "设定") + "】" + (item.from ? item.from + " → " : "") + (item.to || "") + (item.reason ? "（" + item.reason + "）" : "");
    const idx = existing.indexOf("\n## 演化史");
    const base = (idx >= 0 ? existing.slice(0, idx) : existing).trimEnd();
    const oldLines = idx >= 0 ? existing.slice(idx).split(/\r?\n/).filter(function (l) { return l.trim().length > 0 && l.trim().indexOf("##") !== 0; }) : [];
    if (oldLines.indexOf(line) < 0) oldLines.push(line);
    await engine.writeText(rel, base + "\n\n## 演化史\n" + oldLines.join("\n") + "\n");
    return rel;
  }
  return null;
}

async function semanticRecall(engine, library, query, limit, exec) {
  let terms = [query];
  try {
    const expanded = await engine.generate({
      system: "你是语义检索助手。把用户的检索意图展开成多个用于全文检索的相关关键词。",
      prompt: "检索意图：" + query + "\n请输出 5~8 个相关关键词/近义表达（含情绪词、事件词、人物状态词），逗号分隔，直接输出列表，不要解释。",
      signal: exec && exec.signal
    });
    const extra = expanded.split(/[,，、;\n]/).map(function (t) { return t.trim(); }).filter(function (t) { return t.length >= 2; }).slice(0, 10);
    terms = terms.concat(extra);
  } catch (e) {}
  const qchars = query.replace(/[^\u4e00-\u9fff]/g, "");
  for (let i = 0; i < qchars.length - 1; i++) {
    const bg = qchars.slice(i, i + 2);
    if (!terms.includes(bg)) terms.push(bg);
  }
  // —— 并行召回：所有字面词 ×（项目+书库）与两路向量检索同时发车 ——
  const candidates = [];
  const seen = new Set();
  const tasks = [];
  for (const term of terms) {
    tasks.push(engine.search(term, { limit: 5 }).then(function (hits) { return { kind: "p", hits: hits }; }).catch(function () { return null; }));
    if (library) {
      tasks.push(library.search(term, { limit: 3 }).then(function (r) { return { kind: "l", hits: (r && r.results) || [] }; }).catch(function () { return null; }));
    }
  }
  tasks.push(engine.vectorSearch(query, { limit: 6 }).then(function (vh) { return { kind: "pv", hits: vh }; }).catch(function () { return null; }));
  if (library) {
    tasks.push(library.vectorSearch(query, 6).then(function (lv) { return { kind: "lv", hits: lv && lv.results }; }).catch(function () { return null; }));
  }
  const outcomes = await Promise.all(tasks);
  for (const o of outcomes) {
    if (!o || !o.hits) continue;
    if (o.kind === "p") {
      for (const h of o.hits) {
        const key = "p:" + h.rel;
        if (seen.has(key)) continue; seen.add(key);
        candidates.push({ source: "项目", rel: h.rel, snippet: h.snippet });
      }
    } else if (o.kind === "l") {
      for (const x of o.hits) {
        const key = "l:" + x.novelId + ":" + x.chapterFile;
        if (seen.has(key)) continue; seen.add(key);
        candidates.push({ source: "书库", rel: x.novelTitle + " · " + x.chapterTitle, snippet: x.snippet });
      }
    } else if (o.kind === "pv") {
      for (const h of o.hits) {
        const key = "pv:" + h.rel;
        if (seen.has(key)) continue; seen.add(key);
        candidates.push({ source: "项目(向量)", rel: h.rel, snippet: h.snippet, score: h.score });
      }
    } else if (o.kind === "lv") {
      for (const x of o.hits) {
        const key = "lv:" + x.novelId + ":" + x.chunkIdx;
        if (seen.has(key)) continue; seen.add(key);
        const lvRel = x.novelTitle + " · " + (x.chunkIdx !== undefined ? "片段" + x.chunkIdx : (x.matched && x.matched.length ? "概念命中 " + x.matched.join(" / ") : "片段"));
        candidates.push({ source: "书库(向量)", rel: lvRel, snippet: x.snippet, score: x.score });
      }
    }
  }
  try {
    const recentFiles = (await engine.listFiles("chapters")).sort().slice(-5);
    for (const rel of recentFiles) {
      const key = "p:" + rel;
      if (seen.has(key)) continue; seen.add(key);
      let text = "";
      try { text = await engine.readText(rel); } catch (e) {}
      candidates.push({ source: "项目", rel: rel, snippet: text.slice(0, 200) });
    }
  } catch (e) {}
  // —— 惰性回填：顺手为少量缺向量的文档补嵌（异步、不阻塞、失败静默），多次检索后索引渐全 ——
  try { engine.embedMissing({ cap: 10 }).catch(function () {}); } catch (e) {}
  if (library) { try { library.embedMissing({ cap: 10 }).catch(function () {}); } catch (e) {} }
  if (!candidates.length) return [];
  if (candidates.length === 1) return candidates;
  try {
    const ctxt = candidates.slice(0, 20).map(function (c, i) { return "[" + (i + 1) + "] " + c.source + " · " + c.rel + "\n" + c.snippet; }).join("\n\n");
    const ranked = await engine.generate({
      system: "你是语义检索排序器。根据用户意图，从候选中选出「含义上」最相关的条目。",
      prompt: "检索意图：" + query + "\n\n候选：\n" + ctxt + "\n\n请输出语义最相关的条目编号（逗号分隔，最多 " + (limit || 6) + " 个）；若都不相关，输出「无」。",
      signal: exec && exec.signal
    });
    const ids = (ranked.match(/\d+/g) || []).map(Number).filter(function (n) { return n >= 1 && n <= candidates.length; }).slice(0, limit || 6);
    if (ids.length) return ids.map(function (i) { return candidates[i - 1]; });
    if (String(ranked).indexOf("无") >= 0) return [];
  } catch (e) {}
  return candidates.slice(0, limit || 6);
}

export function registerWritingTools(ctx, engine, library) {
  ctx.tools.register(defineTool({
    name: "novel_init",
    description: "初始化或更新一部小说的项目：写入书名/简介/题材/主角/核心设定等元信息，并建立 lore/、outline/、chapters/、research/ 目录骨架。长篇创作前先调用一次。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      synopsis: { type: "string", description: "一句话/一段话简介（核心卖点）" },
      genre: { type: "string", description: "题材/类型，如 玄幻、都市、科幻、悬疑" },
      protagonist: { type: "string", description: "主角设定简述" },
      cheat: { type: "string", description: "金手指/核心设定（如有）" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const manifest = await engine.ensureProject({
        title: args.title,
        synopsis: args.synopsis || "",
        genre: args.genre || "",
        protagonist: args.protagonist || "",
        cheat: args.cheat || ""
      });
      return "项目已初始化。\n- 书名：" + manifest.title + "\n- 题材：" + (manifest.genre || "（未填）") + "\n- 简介：" + (manifest.synopsis || "（未填）") + "\n\n目录结构：\nlore/（人物、世界观、时间线、伏笔）\noutline/（主线与分卷/章节细纲）\nchapters/（正文）\nresearch/（考据与审校笔记）";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_brainstorm",
    description: "用插件独立的 DeepSeek key 并发生成 N 个“新奇、出其不意”的创作点子（金手指、反转、情节钩子、冲突设定等）。卡文或开新书时用来找灵感。",
    parameters: {
      context: { type: "string", required: true, description: "背景/当前设定或瓶颈描述" },
      count: { type: "integer", description: "生成点子的数量，默认 5，最多 12" },
      angle: { type: "string", description: "点子方向，如 金手指/反转/伏笔/冲突/世界观" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const count = Math.min(12, Math.max(1, args.count || 5));
      const angle = args.angle ? "方向：" + args.angle + "。" : "";
      const tasks = [];
      for (let i = 0; i < count; i++) {
        tasks.push({
          system: "你是资深网文策划，专出让人眼前一亮、逻辑自洽的创作点子。",
          prompt: "背景：" + args.context + "\n" + angle + "请给出第 " + (i + 1) + " 个独立点子：一句话命名 + 3~5 句展开（讲清爽点、冲突、反转或逻辑自洽点）。不要重复其它编号。"
        });
      }
      const results = await engine.generateMany(tasks, { signal: exec && exec.signal });
      const lines = results.map(function (r, i) { return "### 点子 " + (i + 1) + "\n" + String(r || "").trim(); }).join("\n\n");
      return "已并发生成 " + count + " 个点子：\n\n" + lines;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_outline",
    description: "生成或展开小说大纲（main 主线 / volume 分卷 / chapter 章节细纲）。volume/chapter 级会并行展开。结果写入 outline/ 目录。",
    parameters: {
      level: { type: "string", required: true, enum: ["main", "volume", "chapter"], description: "大纲层级：main 主线 / volume 分卷 / chapter 章节细纲" },
      subject: { type: "string", required: true, description: "要展开的内容（书名/主线/某卷某章节的简述）" },
      count: { type: "integer", description: "要并行生成的条目数（volume/chapter 级），默认 5，最多 16" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const level = args.level;
      const count = Math.min(16, Math.max(1, args.count || 5));
      const context = await gatherContext(engine, { recentChapters: 0 });
      let result;
      if (level === "main") {
        result = await engine.generate({
          system: "你是资深网文大纲师，擅长搭建主线结构、阶段节奏与爽点排布。",
          prompt: context + "\n\n【任务】围绕「" + args.subject + "」写一份主线大纲：核心冲突、主角目标、主要阶段（3~5 幕）、关键转折与高潮。用 Markdown 层级书写。",
          signal: exec && exec.signal
        });
      } else {
        const label = level === "volume" ? "分卷大纲" : "章节细纲";
        const tasks = [];
        for (let i = 0; i < count; i++) {
          tasks.push({
            system: "你是资深网文细纲师，输出结构清晰、有冲突有爽点的细纲。",
            prompt: context + "\n\n【任务】围绕「" + args.subject + "」，写出第 " + (i + 1) + " 个" + label + "（含 3~6 个关键情节点，各 1~2 句）。不要与其它编号重复。"
          });
        }
        const results = await engine.generateMany(tasks, { signal: exec && exec.signal });
        result = results.map(function (r, i) { return "## " + (level === "volume" ? "分卷" : "章节") + " " + (i + 1) + "\n" + String(r || "").trim(); }).join("\n\n");
      }
      const rel = "outline/" + level + "-" + stamp() + ".md";
      await engine.writeText(rel, result);
      return "已写入 " + rel + "：\n\n" + result.slice(0, 8000);
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_lore",
    description: "人物卡/世界观/时间线/伏笔等设定的增删改查。设定持久化到 lore/<分类>/<条目>.md，长篇写作靠它保持一致性。",
    parameters: {
      action: { type: "string", required: true, enum: ["get", "list", "set", "delete", "compact"], description: "操作：list 列全部 / get 读 / set 写 / delete 删 / compact 压缩（防卡片无限膨胀）" },
      category: { type: "string", enum: ["characters", "world", "timeline", "foreshadowing", "other"], description: "设定分类" },
      name: { type: "string", description: "条目名（get/set/delete 必填，作为文件名，用英文/拼音 kebab-case）" },
      content: { type: "string", description: "set 时的 Markdown 内容" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (args.action === "compact") {
        const renderCompact = function (existing, compressed) {
          const m = String(existing || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
          const fm = m ? m[1] : "subject: " + name;
          return "---\n" + fm + "\n---\n\n" + String(compressed || "").trim() + "\n";
        };
        // 单卡压缩
        if (args.name) {
          const rel = "lore/" + (args.category || "characters") + "/" + args.name + ".md";
          let existing = "";
          try { existing = await engine.readText(rel); } catch (e) { return "条目不存在：" + rel; }
          const before = countWords(existing);
          const compressed = await engine.generate({
            system: "你是设定档案压缩师。忠实原文，不编造、不删除任何关键设定。",
            prompt: "请压缩以下设定卡：保留最新状态（合并重复表述），历史内容折叠为「## 历史沿革」小节（按时间顺序只留要点），删除重复与过时表述。直接输出压缩后的 Markdown 正文（不含 front-matter）：\n\n" + existing.slice(0, 8000),
            signal: exec && exec.signal
          });
          await engine.writeText(rel, renderCompact(existing, compressed));
          return "已压缩 " + rel + "（" + before + " 字 → " + countWords(compressed) + " 字）。历史折叠为「历史沿革」小节，front-matter 元数据保留。";
        }
        // 全量压缩：一次调用压缩全部设定卡（防慢性膨胀）
        const cats = ["characters", "world", "timeline", "foreshadowing", "other"];
        const items = [];
        const skip = ["plot-log.md", "inbox.md", "conflicts.md", "style-profile.md", "README.md"];
        for (const cat of cats) {
          const files = (await engine.listFiles("lore/" + cat)).filter(function (f) { return f.endsWith(".md") && skip.indexOf(f) < 0; });
          for (const f of files) {
            let t = "";
            try { t = await engine.readText("lore/" + cat + "/" + f); } catch (e) { continue; }
            items.push({ rel: "lore/" + cat + "/" + f, text: t });
          }
        }
        if (!items.length) return "（暂无设定卡可压缩）";
        const totalBefore = items.reduce(function (s, it) { return s + countWords(it.text); }, 0);
        const result = await engine.generate({
          json: true,
          system: "你是设定档案压缩师。忠实原文，不编造、不删除任何关键设定。",
          prompt: "请逐个压缩以下设定卡（保留最新状态，历史折叠为「## 历史沿革」，删除重复表述）。输出 JSON：{\"items\":[{\"index\":编号,\"content\":\"压缩后正文\"}]}，只包含压缩过的条目：\n\n" + items.map(function (it, i) { return "[" + i + "] " + it.rel + "\n" + it.text.slice(0, 1500); }).join("\n\n"),
          signal: exec && exec.signal
        });
        let arr = [];
        try { arr = JSON.parse(String(result).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()).items || []; } catch (e) { return "压缩结果解析失败：\n" + result.slice(0, 400); }
        let n = 0, after = 0;
        for (const it of arr) {
          const src = items[Number(it.index)];
          if (!src || !it.content) continue;
          await engine.writeText(src.rel, renderCompact(src.text, it.content));
          n++;
          after += countWords(it.content);
        }
        return "已批量压缩 " + n + "/" + items.length + " 张设定卡（" + totalBefore + " 字 → 约 " + after + " 字）。历史折叠为「历史沿革」，元数据保留。";
      }
      if (args.action === "list") {
        const files = await engine.listFiles("lore");
        const byCat = {};
        for (const f of files) {
          const cat = f.split("/")[0] || "other";
          (byCat[cat] = byCat[cat] || []).push(f);
        }
        const lines = [];
        for (const cat of Object.keys(byCat).sort()) {
          lines.push("## " + cat);
          for (const f of byCat[cat]) lines.push("- " + f);
        }
        return lines.length ? lines.join("\n") : "（暂无设定条目，可用 novel_lore set 添加）";
      }
      const category = args.category || "other";
      const name = String(args.name || "").trim();
      if (!name) return "缺少 name（条目名）";
      const rel = "lore/" + category + "/" + name + ".md";
      if (args.action === "get") {
        try { return await engine.readText(rel); } catch (e) { return "条目不存在：" + rel; }
      }
      if (args.action === "set") {
        await engine.writeText(rel, args.content || "");
        return "已保存设定条目：" + rel + "（" + countWords(args.content) + " 字）";
      }
      if (args.action === "delete") {
        try { await engine.deleteFile(rel); return "已删除：" + rel; } catch (e) { return "条目不存在：" + rel; }
      }
      return "未知操作：" + args.action;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_draft",
    description: "起草一章正文：综合作品信息、设定、大纲与上一章结尾，生成一章并保存到 chapters/<id>.md，更新进度。返回保存路径与字数预览，正文可用 read 工具读取。",
    parameters: {
      chapterId: { type: "string", required: true, description: "章节标识（如 vol01-ch001 或 ch012），用作文件名" },
      title: { type: "string", description: "本章标题" },
      volume: { type: "string", description: "分卷名（如 第一卷），缺省不分卷" },
      instruction: { type: "string", description: "本章要发生的事/要点，越具体越好" },
      targetWords: { type: "integer", description: "目标字数（中文），默认 2000" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const target = args.targetWords || 2000;
      const context = await gatherContext(engine, { level: "minimal", recentChapters: 1 });
      const text = await engine.generate({
        system: "你是资深网文作者，文笔老练，节奏好，会写冲突、对话与画面感。严格按大纲与设定写作，不与已确立设定矛盾。",
        prompt: context + "\n\n【本章任务】\n标题：" + (args.title || "") + "\n要求：" + (args.instruction || "（按大纲自然推进）") + "\n目标字数：" + target + " 字。请直接输出本章正文（Markdown，可含分节），不要写创作说明。",
        signal: exec && exec.signal
      });
      const vol = args.volume ? safeName(args.volume) : "";
      const rel = "chapters/" + (vol ? vol + "/" : "") + args.chapterId + ".md";
      await engine.writeText(rel, text);
      await recordChapter(engine, args.chapterId, args.title || "", countWords(text), rel, args.volume);
      return "已起草并保存章节：" + rel + "（" + countWords(text) + " 字）\n\n开头预览：\n" + preview(text, 240) + "\n\n（正文已保存到文件，可用 read 工具读取全文）";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_continue",
    description: "续写：从最近一章的结尾自然续写下一章（自动读取大纲+设定+前文），自动编号并保存，更新进度。",
    parameters: {
      targetWords: { type: "integer", description: "目标字数，默认 2000" },
      instruction: { type: "string", description: "续写方向/要点（可选，缺省按大纲自然推进）" },
      volume: { type: "string", description: "分卷名（可选）" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      const chapterId = "ch" + String(chapters.length + 1).padStart(3, "0");
      const target = args.targetWords || 2000;
      const context = await gatherContext(engine, { level: "minimal", recentChapters: 1 });
      const text = await engine.generate({
        system: "你是资深网文作者，文笔老练。严格按大纲与设定自然续写，不与已确立设定矛盾，不重复前文内容。",
        prompt: context + "\n\n【续写任务】从上一章结尾自然续写下一章。\n" + (args.instruction ? "方向/要点：" + args.instruction + "\n" : "") + "目标字数：" + target + " 字。请直接输出本章正文，不要写创作说明。",
        signal: exec && exec.signal
      });
      const vol = args.volume ? safeName(args.volume) : "";
      const rel = "chapters/" + (vol ? vol + "/" : "") + chapterId + ".md";
      await engine.writeText(rel, text);
      await recordChapter(engine, chapterId, "", countWords(text), rel, args.volume);
      return "已续写并保存：" + rel + "（" + countWords(text) + " 字）\n\n开头预览：\n" + preview(text, 240) + "\n\n（正文已保存到文件，可用 read 工具读取全文）";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_batch",
    description: "用独立 key 并发生成多章草稿（分流/多线任务）：一次性给出多个章节要点，并行起草并各自保存，最后汇总字数与路径。",
    parameters: {
      chapters: {
        type: "array",
        required: true,
        description: "要并行起草的章节列表",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            chapterId: { type: "string", required: true, description: "章节标识（文件名）" },
            title: { type: "string", description: "标题" },
            volume: { type: "string", description: "分卷名" },
            instruction: { type: "string", description: "本章要点" },
            targetWords: { type: "integer", description: "目标字数，默认 2000" }
          }
        }
      },
      concurrency: { type: "integer", description: "并发数，默认取引擎配置" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const chapters = args.chapters || [];
      if (!chapters.length) return "章节列表为空";
      const context = await gatherContext(engine, { level: "minimal", recentChapters: 1 });
      const tasks = chapters.map(function (c) {
        return {
          system: "你是资深网文作者，文笔老练。严格按大纲与设定写作，不与已确立设定矛盾。",
          prompt: context + "\n\n【本章任务】\n标题：" + (c.title || "") + "\n要求：" + (c.instruction || "（按大纲自然推进）") + "\n目标字数：" + (c.targetWords || 2000) + " 字。请直接输出本章正文。"
        };
      });
      const results = await engine.generateMany(tasks, { concurrency: args.concurrency, signal: exec && exec.signal });
      const lines = [];
      for (let i = 0; i < chapters.length; i++) {
        const c = chapters[i];
        const text = String(results[i] || "");
        const vol = c.volume ? safeName(c.volume) : "";
        const rel = "chapters/" + (vol ? vol + "/" : "") + c.chapterId + ".md";
        await engine.writeText(rel, text);
        await recordChapter(engine, c.chapterId, c.title || "", countWords(text), rel, c.volume);
        lines.push("- " + c.chapterId + "：" + countWords(text) + " 字 → " + rel);
      }
      return "已并发生成 " + chapters.length + " 章：\n" + lines.join("\n") + "\n\n（正文已保存到文件，可用 read 工具读取）";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_polish",
    description: "润色/改写一段文字或一个文件：在不改变情节与信息的前提下提升表达质感、语气或文风。可写回原文件。",
    parameters: {
      text: { type: "string", description: "要润色的原文；与 file 二选一" },
      file: { type: "string", description: "项目内相对路径（如 chapters/ch001.md）；与 text 二选一" },
      style: { type: "string", description: "目标文风/语气，如 爽文快节奏/细腻白描/冷峻悬疑" },
      instruction: { type: "string", description: "额外改写要求，如 压缩到800字/加强冲突/改第一人称" },
      writeBack: { type: "boolean", description: "file 模式下是否写回原文件，默认 false" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let source = args.text || "";
      let rel = null;
      if (!source && args.file) {
        rel = args.file;
        source = await engine.readText(rel);
      }
      if (!source) return "缺少待润色内容（text 或 file 至少其一）";
      const style = args.style || "保持原有风格，提升表达质感";
      const polished = await engine.generate({
        system: "你是资深文字编辑，擅长在不改变情节与信息的前提下润色与改写。",
        prompt: "【文风要求】" + style + "\n" + (args.instruction ? "【额外要求】" + args.instruction + "\n" : "") + "【原文】\n" + source + "\n\n请输出润色后的完整文本。",
        signal: exec && exec.signal
      });
      if (rel && args.writeBack) {
        await engine.writeText(rel, polished);
        try {
          const m = await engine.readManifest();
          const chs = Array.isArray(m.chapters) ? m.chapters : [];
          const bare = rel.split("/").pop().replace(/\.md$/, "");
          const hit = chs.find(function (c) { return c.path === rel || c.id === bare; });
          if (hit) { hit.status = "polished"; await engine.writeManifest(m); }
        } catch (e) {}
        return "已润色并写回 " + rel + "（" + countWords(polished) + " 字，状态已置为 polished）";
      }
      return polished;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_review",
    description: "一致性审校：检索项目内相关设定与正文片段，筛查人物/剧情/时间线/设定上的前后矛盾与逻辑漏洞，并给出修法建议。",
    parameters: {
      focus: { type: "string", enum: ["characters", "plot", "timeline", "all"], description: "审校维度，默认 all" },
      scope: { type: "string", description: "审校范围/关键词/章节，默认近期章节" },
      save: { type: "boolean", description: "是否保存到 research/，默认 true" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const focus = args.focus || "all";
      const query = args.scope || (focus === "all" ? "" : focus);
      let recalled = [];
      if (query) {
        try { recalled = await semanticRecall(engine, library, query, 8, exec); }
        catch (e) { recalled = []; }
      }
      const evidence = recalled.map(function (r) { return "--- " + r.rel + " ---\n" + r.snippet; }).join("\n\n");
      const focusLabel = {
        characters: "人物（性格/关系/动机/能力是否前后一致）",
        plot: "剧情（因果、逻辑、是否吃书）",
        timeline: "时间线（先后、年龄、时间跨度是否矛盾）",
        all: "人物、剧情、时间线与设定一致性"
      }[focus] || "一致性";
      const extra = [];
      try {
        const evol = JSON.parse(await engine.readText("evolution.json"));
        if (evol.entries && evol.entries.length) extra.push("【演化史】\n" + evol.entries.map(function (e) { return "- " + e.subject + "【" + e.dimension + "】" + (e.from ? e.from + " → " : "") + e.to; }).join("\n"));
      } catch (e) {}
      try {
        const thr = JSON.parse(await engine.readText("threads.json"));
        if (thr.threads && thr.threads.length) extra.push("【线索】\n" + thr.threads.map(function (t) { return "- " + t.name + " [" + (t.status || "active") + "]"; }).join("\n"));
      } catch (e) {}
      try {
        const fore = JSON.parse(await engine.readText("foreshadowing.json"));
        if (fore.entries && fore.entries.length) extra.push("【伏笔】\n" + fore.entries.map(function (x) { return "- " + x.name + (x.resolvedIn ? "（已回收 @" + x.resolvedIn + "）" : "（未回收）"); }).join("\n"));
      } catch (e) {}
      const extraText = extra.join("\n\n");
      const text = await engine.generate({
        effort: "high",
system: "你是资深网文编辑，擅长发现设定冲突、前后矛盾与逻辑漏洞。只报告确凿问题，不吹毛求疵。",
        prompt: "【审校维度】" + focusLabel + "\n\n【相关片段】\n" + (evidence || "（证据不足，请基于一般网文一致性原则给出提醒）") + (extraText ? "\n\n【一致性档案（演化史/线索/伏笔）】\n" + extraText : "") + "\n\n请列出发现的问题（编号），每条给出：位置、问题描述、建议修法。",
        signal: exec && exec.signal
      });
      if (args.save !== false) {
        await engine.writeText("research/review-" + stamp() + ".md", "# 审校报告\n\n" + text);
      }
      return text;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_research",
    description: "资料检索/考据：就一个主题并行检索网络资料，归纳成可直接引用的考据笔记，并保存到 research/。",
    parameters: {
      topic: { type: "string", required: true, description: "考据/资料主题" },
      questions: { type: "array", items: { type: "string" }, description: "要查清的具体问题列表" },
      save: { type: "boolean", description: "是否保存到 research/，默认 true" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const web = ctx.get("web");
      const questions = args.questions && args.questions.length ? args.questions : [args.topic];
      const snippets = [];
      if (web && typeof web.search === "function") {
        for (const q of questions.slice(0, 6)) {
          try {
            const r = await web.search({ query: q, maxResults: 5 }, exec && exec.signal);
            const src = ((r && r.sources) || []).map(function (s) { return "- " + (s.title || s.url) + "\n  " + (s.snippet || ""); }).join("\n");
            snippets.push("## 问题：" + q + "\n" + (r && r.content ? r.content + "\n" : "") + src);
          } catch (e) {
            snippets.push("## 问题：" + q + "\n（检索失败：" + e.message + "）");
          }
        }
      } else {
        return "当前环境未提供 web 检索服务，请改用内置 web_search 工具逐个检索后让我归纳。";
      }
      const summary = await engine.generate({
        system: "你是严谨的资料编辑，把检索到的资料归纳为可写作直接引用的考据笔记，保留事实与出处。",
        prompt: "【主题】" + args.topic + "\n\n" + snippets.join("\n\n") + "\n\n请归纳成结构化考据笔记（Markdown），标注关键事实与出处。",
        signal: exec && exec.signal
      });
      if (args.save !== false) {
        const safe = String(args.topic).replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);
        await engine.writeText("research/" + safe + "-" + stamp() + ".md", summary);
      }
      return summary;
    }
  }));

  // ── 饲料区（书库）与扩展检索 ───────────────────────────────────────

  ctx.tools.register(defineTool({
    name: "novel_library_import",
    description: "导入一本或多本小说到「饲料区」（书库）：给定文件或目录路径，自动识别编码、按章节标题自动分章并建立索引。支持 .txt/.md/.epub。",
    parameters: {
      source: { type: "string", required: true, description: "小说文件（.txt/.md）的绝对路径，或包含多个文本文件的目录路径" },
      title: { type: "string", description: "书名（缺省用文件名）" },
      author: { type: "string", description: "作者" },
      genre: { type: "string", description: "题材/类型" },
      tags: { type: "array", items: { type: "string" }, description: "标签，如 爽文/种田/无限流" },
      embed: { type: "string", enum: ["lazy", "full", "none"], description: "向量嵌入：lazy 默认（检索时逐步补嵌）；full 导入后立即全量嵌入（慢但一次到位）；none 禁用" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const meta = await library.import({ source: args.source, title: args.title, author: args.author, genre: args.genre, tags: args.tags || [], embed: args.embed || "lazy" });
      let embedNote = "";
      if (meta.embedStats) {
        const es = meta.embedStats;
        embedNote = es.error ? "\n- 向量嵌入：" + es.error : "\n- 向量嵌入：完成 " + es.embedded + " 章 / " + es.chunks + " 块" + (es.failed ? "（失败 " + es.failed + "）" : "");
      } else if (args.embed !== "full") {
        embedNote = "\n- 向量嵌入：lazy（检索时逐步补嵌；可用 novel_embed 立即全量嵌入）";
      }
      return "已导入《" + meta.title + "》到书库：\n- id：" + meta.id + "\n- 章节：" + meta.chapters.length + " 章\n- 字数：" + meta.words + " 字\n- 作者：" + (meta.author || "（未填）") + "\n- 题材：" + (meta.genre || "（未填）") + embedNote + "\n\n可用 novel_library_search 检索、novel_library_read 阅读。";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_library_list",
    description: "列出「饲料区」书库中已导入的小说。",
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const list = await library.list();
      if (!list.length) return "（书库为空，可用 novel_library_import 导入小说）";
      const lines = list.map(function (e, i) { return (i + 1) + ". 《" + e.title + "》 id=" + e.id + " | " + (e.author || "佚名") + " | " + (e.genre || "-") + " | " + e.chapters + " 章 / " + e.words + " 字"; });
      return "书库共 " + list.length + " 本：\n" + lines.join("\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_library_read",
    description: "读取书库中某本小说的某一章（或全书元信息与章节清单）。",
    parameters: {
      id: { type: "string", required: true, description: "小说 id（见 novel_library_list）" },
      chapter: { type: "string", description: "章节文件名或标题（如 ch0003.txt 或 第三章）；缺省返回全书元信息" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const r = await library.read(args.id, args.chapter);
      if (!args.chapter) {
        const list = (r.meta.chapters || []).map(function (c) { return "- " + c.file + "　" + c.title + "（" + c.words + " 字）"; });
        return "《" + r.meta.title + "》共 " + (r.meta.chapters || []).length + " 章 / " + r.meta.words + " 字\n\n章节清单：\n" + list.join("\n");
      }
      return "《" + r.meta.title + "》" + r.chapter.title + "：\n\n" + r.text.slice(0, 6000);
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_library_delete",
    description: "从书库删除一本已导入的小说。",
    parameters: {
      id: { type: "string", required: true, description: "小说 id" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await library.remove(args.id);
      return "已从书库删除：" + args.id;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_library_search",
    description: "在书库中全文检索：按人名/地名/概念/情节关键词查找相关章节并给出片段（基于索引，覆盖所有已导入小说）。",
    parameters: {
      query: { type: "string", required: true, description: "检索词（人名、设定、情节等）" },
      limit: { type: "integer", description: "返回条数，默认 10" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const r = await library.search(args.query, { limit: args.limit || 10 });
      if (!r.results.length) return "书库中未检索到「" + args.query + "」。（若书库为空，先用 novel_library_import 导入）";
      const lines = r.results.map(function (x, i) { return (i + 1) + ". 《" + x.novelTitle + "》" + x.chapterTitle + "（" + x.chapterFile + "）\n   " + x.snippet; });
      return "「" + args.query + "」命中 " + r.results.length + " 处：\n\n" + lines.join("\n\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_search",
    description: "扩展检索：在当前小说项目（正文/设定/大纲）与书库中同时全文检索，用于考据、追设定、查前文。",
    parameters: {
      query: { type: "string", required: true, description: "检索词（人名、地名、设定、情节等）" },
      scope: { type: "string", enum: ["project", "library", "all"], description: "范围：project 当前项目 / library 书库 / all 全部，默认 all" },
      limit: { type: "integer", description: "每类返回条数，默认 6" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const scope = args.scope || "all";
      const limit = args.limit || 6;
      const parts = [];
      if (scope === "project" || scope === "all") {
        const hits = await engine.search(args.query, { limit: limit });
        const lines = hits.map(function (h) { return "- [" + h.rel + "] " + h.snippet; });
        parts.push("【当前项目】" + (lines.length ? "\n" + lines.join("\n") : "（无命中）"));
      }
      if (scope === "library" || scope === "all") {
        const r = await library.search(args.query, { limit: limit });
        const lines = r.results.map(function (x) { return "- 《" + x.novelTitle + "》" + x.chapterTitle + "：" + x.snippet; });
        parts.push("【书库】" + (lines.length ? "\n" + lines.join("\n") : "（无命中）"));
      }
      return "检索「" + args.query + "」：\n\n" + parts.join("\n\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_status",
    description: "查看当前小说项目进度：作品信息、分卷与章节统计、总字数、最近章节。",
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      const volumes = {};
      for (const c of chapters) {
        const v = c.volume || "（未分卷）";
        (volumes[v] = volumes[v] || []).push(c);
      }
      const total = chapters.reduce(function (s, c) { return s + (c.words || 0); }, 0);
      const lines = [];
      lines.push("《" + (manifest.title || "未命名") + "》" + (manifest.genre ? "（" + manifest.genre + "）" : ""));
      for (const v of Object.keys(volumes)) {
        const cs = volumes[v];
        const vw = cs.reduce(function (s, c) { return s + (c.words || 0); }, 0);
        lines.push("◆ " + v + "：" + cs.length + " 章 / " + vw + " 字");
        for (const c of cs) lines.push("  - " + c.id + "　" + (c.title || "") + "（" + (c.words || 0) + " 字）");
      }
      lines.push("总计：" + chapters.length + " 章 / " + total + " 字");
      if (manifest.lastChapter) lines.push("最近章节：" + manifest.lastChapter);
      return lines.join("\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_export",
    description: "导出当前小说为单个 Markdown 或 TXT 文件（按分卷/章节顺序拼接，含标题与简介）。",
    parameters: {
      format: { type: "string", enum: ["markdown", "txt"], description: "导出格式，默认 markdown" },
      filename: { type: "string", description: "导出文件名（不含扩展名），默认书名" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const fmt = args.format || "markdown";
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      const parts = [];
      parts.push("# " + (manifest.title || "未命名"));
      if (manifest.synopsis) parts.push("> " + manifest.synopsis);
      const volumes = {};
      for (const c of chapters) { const v = c.volume || ""; (volumes[v] = volumes[v] || []).push(c); }
      for (const v of Object.keys(volumes)) {
        if (v) parts.push(fmt === "markdown" ? "\n## " + v : "\n\n【" + v + "】");
        for (const c of volumes[v]) {
          let text;
          try { text = await engine.readText(c.path); } catch (e) { continue; }
          // 去掉正文自带的标题行（如 draft 输出的 ## 第N章 xx），避免与导出标题重复/层级混乱
          text = String(text).replace(/^#+\s*(?:第\s*\d+\s*[章节回]|Chapter\s+\d+)[^\n]*\n/, "").trimStart();
          parts.push(fmt === "markdown" ? "\n### " + (c.title || c.id) + "\n\n" + text : "\n\n" + (c.title || c.id) + "\n\n" + text);
        }
      }
      const content = parts.join("\n");
      const ext = fmt === "markdown" ? "md" : "txt";
      const base = safeName((args.filename || manifest.title || "novel").replace(/\.[^.]+$/, ""));
      const rel = "export/" + base + "." + ext;
      await engine.writeText(rel, content);
      return "已导出 " + chapters.length + " 章到 " + rel + "（" + countWords(content) + " 字）";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_summarize",
    description: "为章节或近期章节生成简短情节摘要，追加到可检索的情节日志（lore/other/plot-log.md），帮助长篇小说跨章节记忆剧情与伏笔。",
    parameters: {
      chapterId: { type: "string", description: "要摘要的章节 id；缺省摘要最近 N 章" },
      recent: { type: "integer", description: "摘要最近 N 章（chapterId 未给时生效），默认 3" },
      instruction: { type: "string", description: "摘要侧重点（如 只记关键转折/人物关系/伏笔）" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      let targets = [];
      if (args.chapterId) {
        const c = chapters.find(function (x) { return x.id === args.chapterId; });
        if (!c) return "章节不存在：" + args.chapterId;
        targets = [c];
      } else {
        targets = chapters.slice(-Math.max(1, args.recent || 3));
      }
      if (!targets.length) return "（尚无章节可摘要）";
      const excerpts = [];
      for (const c of targets) {
        let text;
        try { text = await engine.readText(c.path); } catch (e) { text = ""; }
        excerpts.push("【" + c.id + " " + (c.title || "") + "】\n" + text.slice(0, 6000));
      }
      const summary = await engine.generate({
        system: "你是资深网文编辑，擅长提炼情节摘要。只记关键剧情、人物关键动作与伏笔，不评价。",
        prompt: "请为以下章节写一段 150~300 字的情节摘要（含：核心事件、人物关键动作、埋下的伏笔）：\n\n" + excerpts.join("\n\n") + (args.instruction ? "\n\n侧重点：" + args.instruction : ""),
        signal: exec && exec.signal
      });
      const rel = "lore/other/plot-log.md";
      let log = "";
      try { log = await engine.readText(rel); } catch (e) { log = ""; }
      const entry = "\n\n## " + stamp() + " · " + targets.map(function (c) { return c.id; }).join(",") + "\n" + summary;
      await engine.writeText(rel, (log + entry).trim());
      return summary;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_setting_extract",
    description: "从正文自动抽取设定（人物/世界观/伏笔）并写入 lore/ 对应分类，减少手动维护设定卡。",
    parameters: {
      chapterId: { type: "string", description: "从哪章抽取；缺省抽取最近 N 章" },
      recent: { type: "integer", description: "抽取最近 N 章，默认 2" },
      category: { type: "string", enum: ["characters", "world", "foreshadowing"], required: true, description: "抽取类型：人物/世界观/伏笔" },
      instruction: { type: "string", description: "额外抽取要求/重点" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      let targets = [];
      if (args.chapterId) {
        const c = chapters.find(function (x) { return x.id === args.chapterId; });
        if (!c) return "章节不存在：" + args.chapterId;
        targets = [c];
      } else {
        targets = chapters.slice(-Math.max(1, args.recent || 2));
      }
      if (!targets.length) return "（尚无章节可抽取）";
      const excerpts = [];
      for (const c of targets) {
        let text;
        try { text = await engine.readText(c.path); } catch (e) { text = ""; }
        excerpts.push("【" + c.id + "】\n" + text.slice(0, 6000));
      }
      const label = {
        characters: "人物（姓名、身份、性格、能力、与他人的关系）",
        world: "世界观（地理、势力、力量体系、规则）",
        foreshadowing: "伏笔（埋下的线索与暗示）"
      }[args.category];
      const result = await engine.generate({
        effort: "high",
system: "你是网文设定整理师。只从给定正文抽取，不编造原文没有的信息。",
        prompt: "【抽取类型】" + label + "\n\n【正文】\n" + excerpts.join("\n\n") + "\n\n请输出 JSON 对象：{\"items\":[{\"name\":\"条目名\",\"summary\":\"一两句描述\"}]}。" + (args.instruction ? " 要求：" + args.instruction : ""),
        json: true,
        signal: exec && exec.signal
      });
      const items = parseItems(result);
      if (!items.length) return "未抽取到设定项，模型输出：\n" + result.slice(0, 400);
      const lines = [];
      for (const it of items) {
        const name = safeName(it.name || "条目");
        const rel = await writeLoreCard(engine, args.category, name, it.summary || "", { chapterRef: (targets[0] && targets[0].id) || "" });
        lines.push("- " + name + " → " + rel);
      }
      return "已抽取 " + items.length + " 项设定：\n" + lines.join("\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_foreshadow",
    description: "伏笔回收追踪：登记伏笔、标注回收章节、查看未回收伏笔，防止长篇挖坑不填。",
    parameters: {
      action: { type: "string", required: true, enum: ["track", "resolve", "list", "unresolved"], description: "track 登记 / resolve 回收 / list 全列 / unresolved 未回收" },
      name: { type: "string", description: "伏笔名（track/resolve 必填）" },
      description: { type: "string", description: "伏笔描述（track 用）" },
      plantedIn: { type: "string", description: "埋设章节 id（track 用）" },
      resolvedIn: { type: "string", description: "回收章节 id（resolve 用）" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      let data = { entries: [] };
      try { data = JSON.parse(await engine.readText("foreshadowing.json")); } catch (e) { data = { entries: [] }; }
      const entries = Array.isArray(data.entries) ? data.entries : [];
      if (args.action === "track") {
        const name = String(args.name || "").trim();
        if (!name) return "缺少 name（伏笔名）";
        const entry = { name: name, description: args.description || "", plantedIn: args.plantedIn || "", resolvedIn: null, createdAt: new Date().toISOString() };
        const idx = entries.findIndex(function (x) { return x.name === name; });
        if (idx >= 0) entries[idx] = entry; else entries.push(entry);
        await engine.writeText("foreshadowing.json", JSON.stringify({ entries: entries }, null, 2) + "\n");
        return "已登记伏笔「" + name + "」" + (args.plantedIn ? "（埋于 " + args.plantedIn + "）" : "");
      }
      if (args.action === "resolve") {
        const name = String(args.name || "").trim();
        const e = entries.find(function (x) { return x.name === name; });
        if (!e) return "伏笔不存在：" + name;
        e.resolvedIn = args.resolvedIn || "";
        e.resolvedAt = new Date().toISOString();
        await engine.writeText("foreshadowing.json", JSON.stringify({ entries: entries }, null, 2) + "\n");
        return "已标注伏笔「" + name + "」在 " + (args.resolvedIn || "未知章节") + " 回收";
      }
      if (args.action === "unresolved") {
        const un = entries.filter(function (x) { return !x.resolvedIn; });
        if (!un.length) return "（无未回收伏笔）";
        return "未回收伏笔 " + un.length + " 条：\n" + un.map(function (e, i) { return (i + 1) + ". " + e.name + (e.plantedIn ? "（埋于 " + e.plantedIn + "）" : "") + "：" + (e.description || ""); }).join("\n");
      }
      if (!entries.length) return "（尚未登记伏笔）";
      const resolved = entries.filter(function (x) { return x.resolvedIn; }).length;
      return "伏笔共 " + entries.length + " 条（已回收 " + resolved + " / 未回收 " + (entries.length - resolved) + "）：\n" + entries.map(function (e, i) { return (i + 1) + ". " + e.name + " · " + (e.resolvedIn ? "已回收于 " + e.resolvedIn : "未回收") + "：" + (e.description || ""); }).join("\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_brief",
    description: "模糊需求一键开书：把一句话/一段需求展开成完整开书方案（书名备选、简介、题材卖点、金手指、主角人设、主线大纲）。",
    parameters: {
      premise: { type: "string", required: true, description: "一句话/一段需求，如「废柴少年逆袭成神」" },
      style: { type: "string", description: "目标文风（爽文快节奏/细腻白描/冷峻悬疑…）" },
      extra: { type: "string", description: "额外要求/禁忌（如 无系统、单女主、拒绝套路）" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const premise = String(args.premise || "").trim();
      if (!premise) return "缺少 premise（一句话需求）";
      const brief = await engine.generate({
        system: "你是资深网文策划，能把一句模糊需求展开成完整、可执行、有卖点的开书方案。",
        prompt: "【需求】" + premise + (args.style ? "\n【文风】" + args.style : "") + (args.extra ? "\n【额外要求】" + args.extra : "") + "\n\n请输出完整开书方案（Markdown）：\n# 书名（3 个备选）\n# 一句话简介\n# 题材与核心卖点\n# 金手指/核心设定\n# 主角人设（性格/目标/缺陷/成长弧）\n# 主线大纲（3~5 幕，含关键转折与高潮）",
        signal: exec && exec.signal
      });
      const rel = "outline/brief-" + stamp() + ".md";
      await engine.writeText(rel, brief);
      return brief;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_distill",
    description: "蒸馏：把长文本压缩成结构化精华（梗概/人物关系/核心设定/伏笔/金句），并做「保留校验」（对照原文检查是否遗漏关键信息）。覆盖项目文本或书库；手动调用，或由 agent 在写完一卷后自动调用以维持跨卷记忆。",
    parameters: {
      scope: { type: "string", enum: ["project", "library"], description: "蒸馏对象：project 当前项目文本 / library 书库某本，默认 project" },
      target: { type: "string", description: "章节 id（project）或书库 id（library）；缺省蒸馏最近 N 章" },
      recent: { type: "integer", description: "蒸馏最近 N 章（project 且未给 target 时），默认 3" },
      instruction: { type: "string", description: "蒸馏侧重点（如 侧重伏笔/侧重人物弧光）" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const scope = args.scope || "project";
      const texts = [];
      let sourceLabel = "";
      if (scope === "library") {
        if (!args.target) return "缺少 target（书库 id，可用 novel_library_list 查看）";
        const r = await library.read(args.target, null);
        sourceLabel = "书库《" + r.meta.title + "》";
        for (const ch of r.meta.chapters || []) {
          const full = await library.read(args.target, ch.file);
          texts.push({ label: ch.title || ch.file, content: full.text });
        }
      } else {
        let manifest = {};
        try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
        const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
        let targets = [];
        if (args.target) {
          const c = chapters.find(function (x) { return x.id === args.target; });
          if (!c) return "章节不存在：" + args.target;
          targets = [c];
        } else {
          targets = chapters.slice(-Math.max(1, args.recent || 3));
        }
        sourceLabel = "项目 " + targets.map(function (c) { return c.id; }).join(",");
        for (const c of targets) {
          let text;
          try { text = await engine.readText(c.path); } catch (e) { text = ""; }
          texts.push({ label: c.id + " " + (c.title || ""), content: text });
        }
      }
      if (!texts.length) return "（无可蒸馏内容）";
      const excerpts = texts.map(function (t) { return "【" + t.label + "】\n" + t.content.slice(0, 6000); }).join("\n\n");
      let relevant = "";
      try {
        const recall = await semanticRecall(engine, library, args.instruction || sourceLabel, 5, exec);
        if (recall.length) relevant = recall.map(function (r) { return "--- [" + r.source + "] " + r.rel + " ---\n" + r.snippet; }).join("\n\n");
      } catch (e) {}
      const distill = await engine.generate({
        effort: "high",
system: "你是资深内容蒸馏师。把长文本压缩成结构化精华，忠实原文，不编造。",
        prompt: "请蒸馏以下内容为结构化精华（Markdown）：\n## 梗概\n## 关键人物与关系变化\n## 核心设定\n## 伏笔\n## 金句\n\n" + excerpts + (relevant ? "\n\n【全书相关上下文（语义召回，供蒸馏参考，不必照录）】\n" + relevant : "") + (args.instruction ? "\n\n侧重点：" + args.instruction : ""),
        signal: exec && exec.signal
      });
      const verify = await engine.generate({
        effort: "high",
system: "你是严谨的内容审校师。对照原文，检查蒸馏精华是否遗漏关键信息。",
        prompt: "【原文（摘要）】\n" + excerpts.slice(0, 4000) + "\n\n【蒸馏精华】\n" + distill + "\n\n请检查精华是否遗漏：①关键人物及其关系变化 ②已埋/已收的伏笔 ③重要设定/规则 ④关键情节转折。逐条列出遗漏项并给出补充；若完整则回复「无遗漏」。",
        signal: exec && exec.signal
      });
      const ts = stamp();
      const doc = "# 蒸馏笔记 · " + sourceLabel + "\n\n## 精华\n" + distill + "\n\n## 保留校验\n" + verify;
      if (scope === "library") {
        await library.scaffoldAnalysis(args.target);
        await library.writeAnalysis(args.target, "蒸馏/distill-" + ts + ".md", doc);
        return "蒸馏完成，已保存到该书拆解卡（analysis/蒸馏/distill-" + ts + ".md）：\n\n" + doc;
      }
      const rel = "lore/other/distill-" + ts + ".md";
      await engine.writeText(rel, doc);
      return doc;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_handbook",
    description: "生成给人读的「全书导航手册」：世界观概览、人物索引、时间线、伏笔清单、章节导读。让作者在数百万字长文里也能快速掌握全书、做决策。",
    parameters: {
      focus: { type: "string", enum: ["all", "world", "characters", "timeline"], description: "侧重：all 全册 / world 世界观 / characters 人物 / timeline 时间线，默认 all" },
      instruction: { type: "string", description: "额外要求（如 给新读者看/给作者自查用）" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const context = await gatherContext(engine, { level: "full", recentChapters: 0 });
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      const chapterList = chapters.map(function (c) { return "- " + c.id + " " + (c.title || "") + "（" + (c.words || 0) + " 字" + (c.volume ? "，" + c.volume : "") + "）"; }).join("\n");
      const focus = args.focus || "all";
      let highlights = "";
      try {
        const recall = await semanticRecall(engine, library, "全书最精彩的名场面与关键转折", 6, exec);
        if (recall.length) highlights = recall.map(function (r) { return "--- [" + r.source + "] " + r.rel + " ---\n" + r.snippet; }).join("\n\n");
      } catch (e) {}
      const handbook = await engine.generate({
        system: "你是资深网文编辑。生成给人读的导航手册，让人（作者/读者）能快速掌握全书设定、人物、时间线、伏笔与进度。",
        prompt: "【作品】《" + (manifest.title || "") + "》\n\n【已积累的设定/大纲/蒸馏笔记】\n" + context + "\n\n【章节清单】\n" + chapterList + (highlights ? "\n\n【名场面素材（语义召回）】\n" + highlights : "") + "\n\n请生成「全书导航手册」（Markdown）：\n# 世界观概览\n# 人物索引（姓名+身份+关系+现状）\n# 时间线\n# 伏笔清单（含回收状态）\n# 章节导读（按卷归纳，含名场面）\n侧重：" + focus + (args.instruction ? "\n额外要求：" + args.instruction : ""),
        signal: exec && exec.signal
      });
      const rel = "guide/handbook-" + stamp() + ".md";
      await engine.writeText(rel, handbook);
      return handbook;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_simulate",
    description: "深度推演引擎：针对一个局势/决策点，做人物心理、因果、成长线、多人交汇、世界观连锁、常识检验与反常识意外的深度推演，产出可检索的推演报告。用于下笔前的深度思考，赋予情节灵魂（主 agent 可在此基础上进一步深化）。",
    parameters: {
      scene: { type: "string", required: true, description: "当前局势/场景/决策点，如「萧炎被当众退婚，立下三年之约」" },
      characters: { type: "string", description: "涉及人物名（逗号分隔），缺省推演主角与关键相关者" },
      focus: { type: "string", enum: ["all", "psychology", "causal", "growth", "convergence", "world", "counterintuitive"], description: "推演侧重，默认 all 全面推演" },
      instruction: { type: "string", description: "额外推演要求" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const context = await gatherContext(engine, { level: "full", recentChapters: 2, outline: true, lore: true });
      let relevant = "";
      try {
        const recall = await semanticRecall(engine, library, args.scene, 5, exec);
        if (recall.length) relevant = recall.map(function (r) { return "--- [" + r.source + "] " + r.rel + " ---\n" + r.snippet; }).join("\n\n");
      } catch (e) {}
      const focus = args.focus || "all";
      const report = await engine.generate({
        effort: "max",
system: "你是顶级的叙事与心理推演师，擅长深度思考。你只做思考、不写正文。把人物的内心、动机、因果、成长、人际交汇、世界观连锁、乃至反常识的意外，都想透、想深。忠实于已有设定与人物性格，不编造、不 OOC。",
        prompt: "【当前局势】" + args.scene + "\n" + (args.characters ? "【涉及人物】" + args.characters + "\n" : "") + "\n【作品设定/大纲/前文】\n" + context.slice(0, 6000) + (relevant ? "\n\n【全书相关片段（语义召回）】\n" + relevant : "") + "\n\n请针对这个局势做深度推演（Markdown，越深越好，只做思考、不写正文）：\n## 人物心理模拟（此刻每个人内心：动机、恐惧、欲望、潜台词、真实想法与表面反应的落差）\n## 因果推演（每个可能行动 → 后果链，至少 3 条分岔路径）\n## 人物成长线（这个节点对主要人物成长弧的影响，短中长期）\n## 多人交互与交汇（谁影响谁、权力/情感/利益的交汇点与冲突点）\n## 世界观/设定连锁（这个世界对此事的反应、连锁后果、是否违反已有设定）\n## 常识性检验（哪些发展合理、哪些会崩、哪些需要铺垫）\n## 反常识的意外（给出 1~2 个反直觉但逻辑自洽的意外发展，让人眼前一亮）\n侧重：" + focus + (args.instruction ? "\n额外要求：" + args.instruction : ""),
        signal: exec && exec.signal
      });
      const rel = "lore/other/simulate-" + stamp() + ".md";
      const doc = "# 深度推演 · " + args.scene.slice(0, 40) + "\n\n" + report;
      await engine.writeText(rel, doc);
      return doc;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_semantic",
    description: "语义检索：超越字面匹配，按「含义」检索项目与书库（如「主角心境低落的段落」「两人关系出现裂痕的伏笔」）。三段式：语义展开关键词 → 字面召回 → LLM 语义重排。",
    parameters: {
      query: { type: "string", required: true, description: "语义检索意图，如「主角心境低落的段落」" },
      limit: { type: "integer", description: "返回条数，默认 6" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const query = String(args.query || "").trim();
      if (!query) return "缺少 query（语义检索意图）";
      const limit = args.limit || 6;
      const chosen = await semanticRecall(engine, library, query, limit, exec);
      if (!chosen.length) return "语义检索「" + query + "」：未找到相关段落。";
      return "语义检索「" + query + "」：\n\n" + chosen.map(function (c) { return "- [" + c.source + "] " + c.rel + "\n  " + c.snippet; }).join("\n\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_evolution",
    description: "设定/人物演化追踪：记录人物与设定在长文中的版本演变（性格/能力/关系/动机/心理等细节，非仅剧情）。支持手动登记与从正文自动检测。",
    parameters: {
      action: { type: "string", required: true, enum: ["log", "history", "diff", "auto"], description: "log 手动登记 / history 查看演化史 / diff 版本链对比+设定卡陈旧检测 / auto 自动检测最近章节的人物/设定变化" },
      subject: { type: "string", description: "对象名（log/history 用；history 缺省列全部）" },
      dimension: { type: "string", description: "演化维度（log 用）：性格/能力/关系/动机/心理/世界观/设定" },
      from: { type: "string", description: "演化前状态（log 用）" },
      to: { type: "string", description: "演化后状态（log 用）" },
      reason: { type: "string", description: "演化原因/诱因（log 用）" },
      chapterId: { type: "string", description: "发生章节（log 用）" },
      recent: { type: "integer", description: "auto 检测最近 N 章，默认 3" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let data = { entries: [] };
      try { data = JSON.parse(await engine.readText("evolution.json")); } catch (e) { data = { entries: [] }; }
      const entries = Array.isArray(data.entries) ? data.entries : [];
      if (args.action === "log") {
        const subject = String(args.subject || "").trim();
        if (!subject) return "缺少 subject（对象名）";
        const entry = { id: subject + "-" + Date.now().toString(36), subject: subject, dimension: args.dimension || "设定", from: args.from || "", to: args.to || "", reason: args.reason || "", chapterId: args.chapterId || "", createdAt: new Date().toISOString() };
        entries.push(entry);
        await engine.writeText("evolution.json", JSON.stringify({ entries: entries }, null, 2) + "\n");
        return "已登记演化：" + subject + "【" + entry.dimension + "】" + (entry.from ? entry.from + " → " : "") + entry.to;
      }
      if (args.action === "history") {
        const subject = String(args.subject || "").trim();
        const list = subject ? entries.filter(function (e) { return e.subject === subject; }) : entries;
        if (!list.length) return "（无演化记录" + (subject ? "：" + subject : "") + "）";
        return "演化史" + (subject ? " · " + subject : "") + "（" + list.length + " 条）：\n" + list.map(function (e, i) { return (i + 1) + ". " + e.subject + "【" + e.dimension + "】" + (e.from ? e.from + " → " : "") + e.to + (e.reason ? "（" + e.reason + "）" : "") + (e.chapterId ? " @ " + e.chapterId : ""); }).join("\n");
      }
      if (args.action === "diff") {
        const subject = String(args.subject || "").trim();
        if (!subject) return "缺少 subject（对象名）";
        const list = entries.filter(function (e) { return e.subject === subject; });
        if (!list.length) return "「" + subject + "」无演化记录";
        let card = "";
        for (const cat of ["characters", "world", "other"]) {
          try { card = await engine.readText("lore/" + cat + "/" + safeName(subject) + ".md"); break; } catch (e) {}
        }
        const latest = list[list.length - 1];
        const chain = list.map(function (e, i) { return "v" + (i + 1) + "【" + e.dimension + "】" + (e.from ? e.from + " → " : "") + e.to + (e.reason ? "（" + e.reason + "）" : "") + (e.chapterId ? " @" + e.chapterId : ""); }).join("\n");
        const stale = card && latest.to && card.indexOf(latest.to) < 0;
        return "「" + subject + "」演化链（" + list.length + " 版）：\n" + chain + "\n\n当前设定卡：" + (card ? "\n" + card : "（无）") + (stale ? "\n\n⚠ 设定卡可能陈旧（未反映最新演化「" + latest.to + "」），建议用 novel_lore set 更新。" : "\n\n✅ 设定卡已反映最新演化。");
      }
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      const targets = chapters.slice(-Math.max(1, args.recent || 3));
      if (!targets.length) return "（尚无章节可检测）";
      const loreTexts = [];
      const loreFiles = await engine.listFiles("lore");
      for (const lf of loreFiles.slice(0, 30)) {
        try { loreTexts.push("--- " + lf + " ---\n" + await engine.readText("lore/" + lf)); } catch (e) {}
      }
      const excerpts = [];
      for (const c of targets) {
        let text;
        try { text = await engine.readText(c.path); } catch (e) { text = ""; }
        excerpts.push("【" + c.id + "】\n" + text.slice(0, 4000));
      }
      const result = await engine.generate({
        effort: "high",
system: "你是设定演化追踪师。对比人物卡/设定与最新正文，检测人物或设定的「细节演变」（性格/能力/关系/动机/心理/世界观），只报确凿变化，不报重复信息。",
        prompt: "【现有设定/人物卡】\n" + loreTexts.join("\n\n").slice(0, 5000) + "\n\n【最近正文】\n" + excerpts.join("\n\n") + "\n\n请检测人物/设定发生了哪些「演化」（与旧设定相比的变化），输出 JSON：{\"items\":[{\"subject\":\"对象名\",\"dimension\":\"性格/能力/关系/动机/心理/世界观/设定\",\"from\":\"演化前\",\"to\":\"演化后\",\"reason\":\"诱因\",\"chapterId\":\"章节\"}]}。若没有明显演化，输出 {\"items\":[]}。",
        json: true,
        signal: exec && exec.signal
      });
      const items = parseItems(result);
      if (!items.length) return "（未检测到明显演化）";
      let added = 0;
      for (const it of items) {
        const entry = { id: (it.subject || "对象") + "-" + Date.now().toString(36) + added, subject: it.subject || "对象", dimension: it.dimension || "设定", from: it.from || "", to: it.to || "", reason: it.reason || "", chapterId: it.chapterId || "", createdAt: new Date().toISOString() };
        entries.push(entry);
        added++;
      }
      await engine.writeText("evolution.json", JSON.stringify({ entries: entries }, null, 2) + "\n");
      return "已自动检测并登记 " + added + " 条演化：\n" + items.map(function (it, i) { return (i + 1) + ". " + (it.subject || "对象") + "【" + (it.dimension || "设定") + "】" + (it.from ? it.from + " → " : "") + it.to + (it.reason ? "（" + it.reason + "）" : ""); }).join("\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_threads",
    description: "多线叙事与线索图谱：登记主线/支线/人物线/伏笔线，标记线索交汇，生成线索图谱，发现停滞线索，防止长文多线混乱或线索失联。",
    parameters: {
      action: { type: "string", required: true, enum: ["track", "list", "link", "update", "graph"], description: "track 登记 / list 列全部 / link 标记交汇 / update 更新进度 / graph 生成图谱" },
      name: { type: "string", description: "线索名（track/link/update 用）" },
      description: { type: "string", description: "线索描述（track 用）" },
      chapterId: { type: "string", description: "涉及/更新到的章节（track/update 用）" },
      with: { type: "string", description: "交汇的另一条线索名（link 用）" },
      status: { type: "string", enum: ["active", "paused", "resolved", "dropped"], description: "状态（update 用）" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      let data = { threads: [] };
      try { data = JSON.parse(await engine.readText("threads.json")); } catch (e) { data = { threads: [] }; }
      const threads = Array.isArray(data.threads) ? data.threads : [];
      if (args.action === "track") {
        const name = String(args.name || "").trim();
        if (!name) return "缺少 name（线索名）";
        if (threads.find(function (t) { return t.name === name; })) return "线索已存在：" + name;
        threads.push({ name: name, description: args.description || "", status: "active", chapters: args.chapterId ? [args.chapterId] : [], intersects: [], createdAt: new Date().toISOString() });
        await engine.writeText("threads.json", JSON.stringify({ threads: threads }, null, 2) + "\n");
        return "已登记线索：「" + name + "」";
      }
      if (args.action === "list") {
        if (!threads.length) return "（尚未登记线索）";
        return "线索共 " + threads.length + " 条：\n" + threads.map(function (t, i) { return (i + 1) + ". " + t.name + " · " + (t.status || "active") + (t.description ? "：" + t.description : "") + (t.chapters.length ? "（涉 " + t.chapters.length + " 章）" : ""); }).join("\n");
      }
      if (args.action === "link") {
        const name = String(args.name || "").trim();
        const withName = String(args.with || "").trim();
        if (!name || !withName) return "缺少 name 或 with";
        const a = threads.find(function (t) { return t.name === name; });
        const b = threads.find(function (t) { return t.name === withName; });
        if (!a || !b) return "线索不存在：" + (a ? withName : name);
        if (!a.intersects.includes(b.name)) a.intersects.push(b.name);
        if (!b.intersects.includes(a.name)) b.intersects.push(a.name);
        await engine.writeText("threads.json", JSON.stringify({ threads: threads }, null, 2) + "\n");
        return "已标记交汇：「" + name + "」 × 「" + withName + "」" + (args.chapterId ? " @ " + args.chapterId : "");
      }
      if (args.action === "update") {
        const name = String(args.name || "").trim();
        const t = threads.find(function (x) { return x.name === name; });
        if (!t) return "线索不存在：" + name;
        if (args.status) t.status = args.status;
        if (args.chapterId && !t.chapters.includes(args.chapterId)) t.chapters.push(args.chapterId);
        await engine.writeText("threads.json", JSON.stringify({ threads: threads }, null, 2) + "\n");
        return "已更新线索：「" + name + "」状态 " + (t.status || "active") + "，涉及 " + t.chapters.length + " 章";
      }
      if (!threads.length) return "（尚未登记线索）";
      const lines = [];
      lines.push("线索图谱（" + threads.length + " 条）：");
      for (const t of threads) {
        lines.push("◆ " + t.name + " [" + (t.status || "active") + "]" + (t.description ? " " + t.description : ""));
        if (t.intersects.length) lines.push("  ↳ 交汇：" + t.intersects.join("、"));
        if (t.chapters.length) lines.push("  ↳ 涉及章节：" + t.chapters.join("、"));
      }
      const stalled = threads.filter(function (t) { return (t.status === "active") && t.chapters.length === 0; });
      if (stalled.length) lines.push("\n⚠ 无进展的活跃线索：" + stalled.map(function (t) { return t.name; }).join("、"));
      return lines.join("\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_style",
    description: "风格指纹：从文本（项目/书库/提供文本）剖析作者文风，生成风格指纹并保存；之后所有生成（draft/continue/batch/polish）自动严格遵守该风格。analyze 剖析 / view 查看 / apply 用风格润色文本。",
    parameters: {
      action: { type: "string", required: true, enum: ["analyze", "view", "apply", "list", "select"], description: "analyze 剖析生成指纹 / view 查看当前 / apply 用指纹润色 / list 列风格档案 / select 切换当前风格" },
      name: { type: "string", description: "风格名（analyze 保存为命名档案 / select 切换），如 热血爽文" },
      source: { type: "string", enum: ["project", "library", "text"], description: "analyze 的来源，默认 project" },
      target: { type: "string", description: "章节 id（project）或书库 id（library）" },
      recent: { type: "integer", description: "analyze 最近 N 章（project），默认 5" },
      text: { type: "string", description: "直接提供的文本（source=text 时用）" },
      file: { type: "string", description: "apply 时要润色的文件（项目内相对路径），与 text 二选一" },
      instruction: { type: "string", description: "apply 时额外要求" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (args.action === "view") {
        try { return await engine.readText("lore/other/style-profile.md"); }
        catch (e) { return "（尚无风格指纹，用 novel_style analyze 剖析你的文本生成）"; }
      }
      if (args.action === "list") {
        const files = await engine.listFiles("lore/other");
        const styles = files.filter(function (x) { return x === "style-profile.md" || x.indexOf("styles/") === 0; });
        if (!styles.length) return "（无风格档案）";
        return "风格档案：\n" + styles.map(function (x) { return "- " + x; }).join("\n");
      }
      if (args.action === "select") {
        const name = String(args.name || "").trim();
        if (!name) return "缺少 name（风格名）";
        let content;
        try { content = await engine.readText("lore/other/styles/" + safeName(name) + ".md"); }
        catch (e) { return "风格档案不存在：" + name; }
        await engine.writeText("lore/other/style-profile.md", content);
        return "已切换到风格「" + name + "」（此后所有生成遵守该风格）";
      }
      if (args.action === "analyze") {
        const source = args.source || "project";
        const samples = [];
        if (source === "text") {
          if (!args.text) return "缺少 text（要剖析的文本）";
          samples.push("【样本】\n" + args.text.slice(0, 8000));
        } else if (source === "library") {
          if (!args.target) return "缺少 target（书库 id）";
          const r = await library.read(args.target, null);
          for (const ch of (r.meta.chapters || []).slice(0, 6)) {
            const full = await library.read(args.target, ch.file);
            samples.push("【" + ch.title + "】\n" + full.text.slice(0, 3000));
          }
        } else {
          let manifest = {};
          try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
          const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
          let targets = [];
          if (args.target) {
            const c = chapters.find(function (x) { return x.id === args.target; });
            if (!c) return "章节不存在：" + args.target;
            targets = [c];
          } else {
            targets = chapters.slice(-Math.max(1, args.recent || 5));
          }
          for (const c of targets) {
            let text;
            try { text = await engine.readText(c.path); } catch (e) { text = ""; }
            samples.push("【" + c.id + "】\n" + text.slice(0, 3000));
          }
        }
        if (!samples.length) return "（无可剖析的文本）";
        const profile = await engine.generate({
          system: "你是文风剖析师。从文本中提取作者的「风格指纹」，供 AI 之后模仿该风格写作。",
          prompt: "请剖析以下文本的风格，输出结构化「风格指纹」（Markdown，简洁但可执行）：\n# 整体文风（2~3 个词概括）\n# 节奏（快/慢、段落长短、爽点密度）\n# 句式（短句/长句、复句偏好、对话占比）\n# 用词（口语/书面、词汇偏好、拟声/动作词）\n# 情绪曲线（先抑后扬/平铺/跌宕）\n# 修辞（比喻/白描/排比偏好）\n# 金句风格（举例 1~2 个原文金句）\n\n样本：\n" + samples.join("\n\n"),
          signal: exec && exec.signal
        });
        const name = String(args.name || "").trim();
        const rel = name ? "lore/other/styles/" + safeName(name) + ".md" : "lore/other/style-profile.md";
        await engine.writeText(rel, profile);
        return "已生成风格指纹并保存到 " + rel + "。此后 novel_draft/continue/batch/polish 将自动严格遵守该风格。\n\n" + profile;
      }
      let source = args.text || "";
      let rel = null;
      if (!source && args.file) { rel = args.file; source = await engine.readText(rel); }
      if (!source) return "缺少 text 或 file（要润色的文本）";
      let style = "";
      try { style = await engine.readText("lore/other/style-profile.md"); } catch (e) {}
      if (!style) return "（尚无风格指纹，先 novel_style analyze 剖析）";
      const polished = await engine.generate({
        system: "你是文风编辑。严格按照给定风格指纹改写文本，保持原意与情节不变，只改风格表达。",
        prompt: "【风格指纹】\n" + style + "\n\n【原文】\n" + source + (args.instruction ? "\n\n【额外要求】" + args.instruction : "") + "\n\n请按风格指纹改写全文。",
        signal: exec && exec.signal
      });
      if (rel) { await engine.writeText(rel, polished); return "已按风格指纹改写并写回 " + rel; }
      return polished;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_decision",
    description: "人机共创决断点：在关键剧情分岔处，生成 2~4 个「选项 + 利弊」的决策框架（每个选项带短期爽点/长期影响/风险/主线契合度 + 反常识选项 + 推荐），供作者做美学决断；决断后由 AI 负责展开。",
    parameters: {
      fork: { type: "string", required: true, description: "剧情分岔点，如「主角面对仇人，是杀是放」" },
      hint: { type: "string", description: "可选方向提示（逗号分隔）" },
      instruction: { type: "string", description: "额外要求" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const context = await gatherContext(engine, { recentChapters: 2 });
      const report = await engine.generate({
        effort: "high",
system: "你是叙事策划师。在关键剧情分岔处，为作者生成「选项 + 利弊」的决策框架，帮作者做有依据的美学决断。不替作者决定，只提供深度分析。",
        prompt: "【分岔点】" + args.fork + (args.hint ? "\n【方向提示】" + args.hint : "") + "\n\n【当前设定/大纲/前文】\n" + context.slice(0, 4000) + "\n\n请生成决策框架（Markdown）：\n## 分岔本质（这个抉择在主题/人物弧光上的意义）\n## 选项 A（命名+一段描述）\n- 短期爽点\n- 长期影响\n- 风险\n- 与主线契合度（高/中/低）\n## 选项 B（同上）\n## 选项 C（同上，如适用）\n## 反常识选项（一个反直觉但自洽的方向，如适用）\n## 我的推荐（1 句理由，但最终由作者决断）" + (args.instruction ? "\n\n额外要求：" + args.instruction : ""),
        signal: exec && exec.signal
      });
      return report;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_scaffold",
    description: "体检并补全写作工程骨架：非破坏式创建缺失的目录、各目录用途说明、台账文件（novel.json / foreshadowing.json / evolution.json）与活目录 chapters/INDEX.md，绝不覆盖已有文件。进入空目录、开新书、或项目缺东少西时先调用一次。",
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const r = await engine.scaffold();
      return "工程骨架体检完成：" + (r.created.length ? "\n- 新建：" + r.created.join("、") : "\n- 全部就绪，无需新建") + "\n\n目录约定：lore/（characters 人物卡带演化史 · world · timeline · foreshadowing · other）、outline/、chapters/（含活目录 INDEX.md）、research/、export/";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_library_analyze",
    description: "把书库中某本书精细拆解成结构化卡片（总览/人物/世界观/情节骨架/爽点与套路/风格/金句），分批增量、可断点续传，结果存入该书 analysis/ 拆解卡。大书一次拆不完自动记录进度，重复调用接着拆。",
    parameters: {
      novelId: { type: "string", required: true, description: "书库 id（novel_library_list 查看）" },
      batch: { type: "integer", description: "每批拆解的章节数，默认 10（分批增量，大书自动断点续传）" },
      focus: { type: "string", enum: ["all", "characters", "world", "plot", "爽点", "style"], description: "拆解侧重：all 全套 / characters 人物 / world 世界观 / plot 情节 / 爽点 爽点套路 / style 风格金句，默认 all" },
      instruction: { type: "string", description: "额外拆解要求" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const r = await library.read(args.novelId, null);
      const chapters = r.meta.chapters || [];
      if (!chapters.length) return "（该书无章节）";
      await library.scaffoldAnalysis(args.novelId);
      const status = await library.analysisStatus(args.novelId);
      const batch = Math.max(1, args.batch || 10);
      const start = status.done || 0;
      const end = Math.min(chapters.length, start + batch);
      if (start >= chapters.length) return "《" + r.meta.title + "》已全部拆解（" + chapters.length + " 章）。侧重调整可带 instruction 重跑，或删除该书 analysis/状态.json 后重来。";
      const focus = args.focus || "all";
      const excerpts = [];
      for (let i = start; i < end; i++) {
        const ch = chapters[i];
        const full = await library.read(args.novelId, ch.file);
        excerpts.push("【" + ch.title + "】\n" + full.text.slice(0, 3000));
      }
      const focusMap = {
        all: "人物与关系、世界观与力量体系、情节骨架与转折、爽点与套路、风格与金句",
        characters: "人物与关系（动机、弧光、关系网变化）",
        world: "世界观与力量体系（规则、势力、地理）",
        plot: "情节骨架与转折（卷级梗概、高潮、钩子）",
        "爽点": "爽点与套路（打脸/升级/收获节奏、金手指用法、情绪设计）",
        style: "风格与金句（叙事视角、节奏、文风、名场面）"
      };
      const result = await engine.generate({
        effort: "high",
        system: "你是资深网文拆解师。只从给定正文拆解归纳，不编造原文没有的信息，不评价好坏。",
        prompt: "拆解《" + r.meta.title + "》第 " + (start + 1) + "~" + end + " 章。侧重：" + focusMap[focus] + "。\n\n【正文】\n" + excerpts.join("\n\n") + "\n\n请输出 JSON 对象：{\"总览\":\"...\",\"人物\":\"...\",\"世界观\":\"...\",\"情节\":\"...\",\"爽点\":\"...\",\"风格金句\":\"...\"}，各字段为 Markdown 文本；与侧重无关的字段输出空字符串。" + (args.instruction ? " 要求：" + args.instruction : ""),
        json: true,
        signal: exec && exec.signal
      });
      let obj = {};
      try { obj = JSON.parse(String(result).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()); } catch (e) { return "拆解结果解析失败：\n" + result.slice(0, 600); }
      const map = {
        "00-总览.md": obj["总览"] || "",
        "01-人物.md": obj["人物"] || "",
        "02-世界观.md": obj["世界观"] || "",
        "03-情节骨架.md": obj["情节"] || "",
        "04-爽点与套路.md": obj["爽点"] || "",
        "05-风格.md": obj["风格"] || "",
        "06-金句素材.md": obj["风格金句"] || ""
      };
      let wrote = 0;
      for (const rel of Object.keys(map)) {
        const val = String(map[rel] || "").trim();
        if (!val) continue;
        const existing = await library.readAnalysis(args.novelId, rel);
        await library.writeAnalysis(args.novelId, rel, existing.trimEnd() + "\n\n## 批次 " + (start + 1) + "~" + end + " 章\n" + val);
        wrote++;
      }
      await library.saveAnalysisStatus(args.novelId, { done: end, total: chapters.length, lastBatchAt: new Date().toISOString() });
      const left = chapters.length - end;
      return "已拆解第 " + (start + 1) + "~" + end + " 章（共 " + chapters.length + " 章），写入 " + wrote + " 张拆解卡。" + (left > 0 ? "还剩 " + left + " 章，再次调用自动续拆。" : "全部完成 ✅") + "\n\n拆解卡位置：书库 " + args.novelId + "/analysis/（总览/人物/世界观/情节骨架/爽点套路/风格/金句）。";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_organize",
    description: "把一段杂乱的设定/笔记文本归纳整理进项目设定库：自动分类（人物/世界观/时间线/伏笔/其他/待定收件箱）、与现有设定去重冲突标记、来源与置信度元数据。防污染设计：无法归类的内容进「待定收件箱」而不是硬塞；与现有设定冲突只标记不覆盖；只抽取不编造。",
    parameters: {
      text: { type: "string", required: true, description: "要整理的原始文本（可粘贴一大段杂乱笔记）" },
      file: { type: "string", description: "项目内文件路径（与 text 二选一）" },
      instruction: { type: "string", description: "整理背景说明（如 这是玄幻世界观草稿）" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let raw = args.text || "";
      if (!raw && args.file) {
        try { raw = await engine.readText(args.file); } catch (e) { return "读取失败：" + args.file; }
      }
      if (!String(raw).trim()) return "（无内容可整理）";
      const result = await engine.generate({
        effort: "high",
        system: "你是严谨的设定归纳师。只从给定文本抽取归纳，绝不编造原文没有的信息；无法归类或零散无关的内容标为 inbox（待定），不要强行归入任何一类。",
        prompt: "请把以下杂乱文本归纳成结构化条目：\n" + String(raw).slice(0, 12000) + "\n\n输出 JSON：{\"items\":[{\"name\":\"条目名\",\"category\":\"characters|world|timeline|foreshadowing|other|inbox\",\"summary\":\"归纳后的描述（忠实原文）\",\"confidence\":\"high|low\"}]}。" + (args.instruction ? " 背景：" + args.instruction : ""),
        json: true,
        signal: exec && exec.signal
      });
      const items = parseItems(result);
      if (!items.length) return "未能归纳出条目，模型输出：\n" + result.slice(0, 400);
      let added = 0, conflicts = 0, inbox = 0;
      const conflictLines = [];
      const inboxLines = [];
      // 预载各分类现有卡名，做模糊去重（同名或互相包含都算冲突候选）
      const cats = ["characters", "world", "timeline", "foreshadowing", "other"];
      const existingNames = {};
      for (const cat of cats) {
        existingNames[cat] = (await engine.listFiles("lore/" + cat)).map(function (f) { return String(f).replace(/\.md$/, ""); });
      }
      for (const it of items) {
        const cat = cats.includes(it.category) ? it.category : "inbox";
        const name = safeName(it.name || "条目");
        const summary = String(it.summary || "").trim();
        if (!summary) continue;
        if (cat === "inbox") {
          inboxLines.push("## " + name + "\n" + summary + "\n");
          inbox++;
          continue;
        }
        const names = existingNames[cat] || [];
        const hit = names.find(function (n) { return n === name || (name.length >= 2 && (n.indexOf(name) >= 0 || name.indexOf(n) >= 0)); });
        if (hit) {
          conflictLines.push("### " + cat + " · " + name + "\n- 现有设定卡：lore/" + cat + "/" + hit + ".md\n- 新归纳内容：" + summary + "\n");
          conflicts++;
          continue;
        }
        await writeLoreCard(engine, cat, name, summary, { extra: { source: "novel_organize", confidence: it.confidence || "low" } });
        existingNames[cat].push(name);
        added++;
      }
      if (inboxLines.length) {
        let cur = "";
        try { cur = await engine.readText("lore/other/inbox.md"); } catch (e) { cur = "# 待定收件箱\n\n> 无法归类或零散的归纳内容，人工确认后再归入对应分类，避免污染设定库。\n"; }
        await engine.writeText("lore/other/inbox.md", cur.trimEnd() + "\n\n" + inboxLines.join("\n").trimEnd() + "\n");
      }
      if (conflictLines.length) {
        let cur = "";
        try { cur = await engine.readText("lore/other/conflicts.md"); } catch (e) { cur = "# 冲突候选\n\n> 归纳内容与现有设定卡同名但内容可能不一致：不覆盖、只标记，人工裁决后合并或忽略。\n"; }
        await engine.writeText("lore/other/conflicts.md", cur.trimEnd() + "\n\n" + conflictLines.join("\n") + "\n");
      }
      return "归纳完成：" + added + " 条新增（写入对应设定卡，带来源/置信度元数据）" + (conflicts ? "、" + conflicts + " 条冲突候选（未覆盖，见 lore/other/conflicts.md）" : "") + (inbox ? "、" + inbox + " 条待定（见 lore/other/inbox.md）" : "") + "。\n\n防污染：只抽取不编造；待定不硬塞；冲突只标记不覆盖。";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_check",
    description: "写作工程全环节体检：一次检查骨架/元信息/大纲/设定/章节台账/伏笔/演化/蒸馏/手册/向量索引/书库/活目录等所有环节完成度，输出 checklist 与下一步建议。新手用它快速历遍框架，老手用它找漏洞。",
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const rows = [];
      function line(state, label, detail) {
        const icon = state === "ok" ? "✅" : state === "warn" ? "⚠️" : state === "error" ? "❌" : "▪️";
        rows.push(icon + " " + label + (detail ? "：" + detail : ""));
      }
      let manifest = null;
      try { manifest = await engine.readManifest(); } catch (e) { manifest = null; }
      const missing = [];
      for (const d of ["lore", "outline", "chapters", "research", "export"]) {
        try { await engine.readText(d + "/README.md"); } catch (e) { missing.push(d); }
      }
      line(missing.length ? "warn" : "ok", "工程骨架", missing.length ? "缺用途说明：" + missing.join("、") + "（novel_scaffold 补全）" : "齐全");
      if (!manifest) line("error", "项目元信息", "无 novel.json（先 novel_init）");
      else {
        line(manifest.title && manifest.title !== "未命名" ? "ok" : "warn", "书名", manifest.title || "未命名");
        line(manifest.genre ? "ok" : "warn", "题材/简介", (manifest.genre || "题材未填") + (manifest.synopsis ? " · 简介已填" : " · 简介未填"));
      }
      const outlineFiles = (await engine.listFiles("outline")).filter(function (f) { return f !== "README.md"; });
      line(outlineFiles.length ? "ok" : "warn", "大纲", outlineFiles.length ? outlineFiles.length + " 份" : "0 份（novel_outline）");
      const loreFiles = (await engine.listFiles("lore")).filter(function (f) { return f.indexOf("other/") !== 0 && f.indexOf("README.md") < 0; });
      line(loreFiles.length ? "ok" : "warn", "设定库", loreFiles.length ? loreFiles.length + " 张卡" : "0 张卡（novel_lore / novel_brief）");
      const chapters = manifest ? (Array.isArray(manifest.chapters) ? manifest.chapters : []) : [];
      if (!chapters.length) line("warn", "章节", "0 章（novel_draft / novel_continue / novel_batch）");
      else {
        const words = chapters.reduce(function (s, c) { return s + (c.words || 0); }, 0);
        const gone = [];
        for (const c of chapters.slice(0, 300)) {
          try { await engine.readText(c.path); } catch (e) { gone.push(c.id); }
        }
        const polished = chapters.filter(function (c) { return c.status === "polished"; }).length;
        line(gone.length ? "warn" : "ok", "章节台账", chapters.length + " 章 / " + words + " 字 / polished " + polished + (gone.length ? "；文件缺失：" + gone.join("、") + "（novel_chapter_remove 清理）" : ""));
      }
      let foreN = 0, foreUn = 0;
      try { const f = JSON.parse(await engine.readText("foreshadowing.json")); foreN = (f.entries || []).length; foreUn = (f.entries || []).filter(function (x) { return !x.resolvedIn; }).length; } catch (e) {}
      line(foreN ? (foreUn ? "warn" : "ok") : "info", "伏笔", foreN + " 条 / 未回收 " + foreUn);
      let evoN = 0;
      try { const e = JSON.parse(await engine.readText("evolution.json")); evoN = (e.entries || []).length; } catch (e) {}
      line(evoN ? "ok" : "info", "演化档案", evoN + " 条");
      const distillFiles = (await engine.listFiles("lore")).filter(function (f) { return f.indexOf("distill-") >= 0; });
      line(distillFiles.length ? "ok" : "info", "蒸馏笔记", distillFiles.length + " 份");
      let handbook = false;
      try { handbook = (await engine.listFiles("lore")).some(function (f) { return f.indexOf("handbook") >= 0; }); } catch (e) {}
      line(handbook ? "ok" : "info", "导航手册", handbook ? "已生成" : "未生成（novel_handbook）");
      try {
        const idx = new SqliteIndex(await engine._indexDbFile());
        const vc = idx.vectorCount();
        idx.close();
        line(vc ? "ok" : "warn", "向量索引", vc + " 个向量块" + (vc ? "" : "（novel_embed 构建）"));
      } catch (e) { line("warn", "向量索引", "未构建（novel_embed）"); }
      const libList = await library.list();
      line(libList.length ? "ok" : "info", "饲料区书库", libList.length + " 本");
      try { await engine.readText("chapters/INDEX.md"); line("ok", "活目录", "已生成"); } catch (e) { line("warn", "活目录", "缺失（novel_sync 自动生成）"); }
      const tips = [];
      if (!manifest) tips.push("novel_init 建项目");
      else {
        if (!manifest.synopsis) tips.push("novel_init 补全书名/题材/简介/主角/核心设定");
        if (!outlineFiles.length) tips.push("novel_outline level=main 搭主线 → volume 分卷 → chapter 细纲");
        if (!loreFiles.length) tips.push("novel_lore 建设定，或把零散笔记丢给 novel_organize 归纳");
      }
      if (!chapters.length) tips.push("novel_draft 写第一章（或 novel_batch 并发多章）");
      else {
        tips.push("novel_sync 章末编排（摘要+抽取+演化+目录刷新）");
        if (foreUn) tips.push("novel_foreshadow list 查看未回收伏笔，安排章节回收");
        if (chapters.length >= 5 && !distillFiles.length) tips.push("novel_distill 蒸馏最近章节，维持跨卷记忆");
      }
      tips.push("novel_embed 建向量索引 → novel_semantic 按含义检索");
      tips.push("novel_handbook 生成导航手册（长篇自查/给人读）");
      return rows.join("\n") + "\n\n【下一步建议】\n" + tips.map(function (t, i) { return (i + 1) + ". " + t; }).join("\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_chapter_remove",
    description: "删除一章：删除正文文件 + 台账条目 + 自动刷新活目录。写废/写错章节时用（配合 novel_draft 重写）。",
    parameters: {
      chapterId: { type: "string", required: true, description: "章节 id（如 ch001）" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const r = await engine.removeChapter(args.chapterId);
      if (r.removed) return "已删除章节 " + r.id + "（文件 + 台账 + 活目录已刷新）。";
      return r.reason === "not-found" ? "章节不存在：" + args.chapterId : "（尚未初始化项目）";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_sync",
    description: "章末自动编排：写完章节后一键执行全套记忆维护（情节摘要 → 设定抽取 → 演化检测 → 未回收伏笔提醒），维持跨卷记忆新鲜。可用 skip 跳过某步骤。",
    parameters: {
      chapterId: { type: "string", description: "刚写完的章节 id；缺省处理最近 N 章" },
      recent: { type: "integer", description: "处理最近 N 章，默认 3" },
      skip: { type: "string", description: "跳过的步骤（逗号分隔：summarize/extract/evolution/foreshadow/catalog）" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      let targets = [];
      if (args.chapterId) {
        const c = chapters.find(function (x) { return x.id === args.chapterId; });
        if (!c) return "章节不存在：" + args.chapterId;
        targets = [c];
      } else {
        targets = chapters.slice(-Math.max(1, args.recent || 3));
      }
      if (!targets.length) return "（尚无章节可编排）";
      const skip = String(args.skip || "").split(/[,，、]/).map(function (s) { return s.trim(); });
      const results = [];
      const excerpts = [];
      for (const c of targets) {
        let text;
        try { text = await engine.readText(c.path); } catch (e) { text = ""; }
        excerpts.push("【" + c.id + " " + (c.title || "") + "】\n" + text.slice(0, 6000));
      }
      const joined = excerpts.join("\n\n");
      const label = targets.map(function (c) { return c.id; }).join(",");
      // 1) 情节摘要
      if (!skip.includes("summarize")) {
        try {
          const summary = await engine.generate({
            system: "你是资深网文编辑，擅长提炼情节摘要。",
            prompt: "请为以下章节写一段 150~300 字情节摘要（核心事件、人物关键动作、埋下的伏笔）：\n\n" + joined,
            signal: exec && exec.signal
          });
          const rel = "lore/other/plot-log.md";
          let log = "";
          try { log = await engine.readText(rel); } catch (e) { log = ""; }
          await engine.writeText(rel, (log + "\n\n## " + stamp() + " · " + label + "\n" + summary).trim());
          const last = targets[targets.length - 1];
          const ch = chapters.find(function (x) { return x.id === last.id; });
          if (ch) { ch.summary = String(summary).replace(/\r?\n/g, " ").slice(0, 120); await engine.writeManifest(manifest); }
          // 情节日志防膨胀：超过 6 万字自动归档，只留尾部 2.5 万字
          if (log.length > 60000) {
            const cut = log.length - 25000;
            const archiveRel = "lore/other/plot-log-archive-" + stamp() + ".md";
            await engine.writeText(archiveRel, log.slice(0, cut));
            await engine.writeText(rel, log.slice(cut));
            results.push("📦 情节日志已归档（" + archiveRel + "）");
          }
          results.push("✅ 情节摘要已写入 plot-log 并同步到台账");
        } catch (e) { results.push("⚠ 摘要失败：" + e.message); }
      }
      // 2) 设定抽取
      if (!skip.includes("extract")) {
        try {
          const extracted = await engine.generate({
            effort: "high",
system: "你是网文设定整理师。只从给定正文抽取，不编造。",
            prompt: "【正文】\n" + joined + "\n\n请输出 JSON：{\"items\":[{\"name\":\"条目名\",\"summary\":\"描述\",\"category\":\"characters 或 world\"}]}。",
            json: true,
            signal: exec && exec.signal
          });
          const items = parseItems(extracted);
          let n = 0;
          for (const it of items) {
            const cat = (it.category === "world") ? "world" : "characters";
            await writeLoreCard(engine, cat, it.name || "条目", it.summary || "", { chapterRef: label });
            n++;
          }
          results.push("✅ 设定抽取 " + n + " 项写入 lore/（设定卡带元数据）");
        } catch (e) { results.push("⚠ 设定抽取失败：" + e.message); }
      }
      // 3) 演化检测
      if (!skip.includes("evolution")) {
        try {
          const loreTexts = [];
          for (const lf of (await engine.listFiles("lore")).slice(0, 30)) {
            try { loreTexts.push("--- " + lf + " ---\n" + await engine.readText("lore/" + lf)); } catch (e) {}
          }
          const result = await engine.generate({
            effort: "high",
system: "你是设定演化追踪师。对比人物卡/设定与最新正文，检测细节演变（性格/能力/关系/动机/心理/世界观）。",
            prompt: "【现有设定】\n" + loreTexts.join("\n\n").slice(0, 5000) + "\n\n【最近正文】\n" + joined + "\n\n输出 JSON：{\"items\":[{\"subject\":\"对象\",\"dimension\":\"性格/能力/...\",\"from\":\"前\",\"to\":\"后\",\"reason\":\"诱因\",\"chapterId\":\"章节\"}]}；无演化输出 {\"items\":[]}。",
            json: true,
            signal: exec && exec.signal
          });
          const items = parseItems(result);
          let data = { entries: [] };
          try { data = JSON.parse(await engine.readText("evolution.json")); } catch (e) { data = { entries: [] }; }
          const entries = Array.isArray(data.entries) ? data.entries : [];
          let n = 0;
          for (const it of items) {
            entries.push({ id: (it.subject || "对象") + "-" + Date.now().toString(36) + n, subject: it.subject || "对象", dimension: it.dimension || "设定", from: it.from || "", to: it.to || "", reason: it.reason || "", chapterId: it.chapterId || "", createdAt: new Date().toISOString() });
            n++;
          }
          if (n) await engine.writeText("evolution.json", JSON.stringify({ entries: entries }, null, 2) + "\n");
          let cards = 0;
          for (const it of items) {
            try { if (await appendEvolutionToCard(engine, it)) cards++; } catch (e) {}
          }
          results.push(n ? "✅ 演化检测登记 " + n + " 条" + (cards ? "（已内嵌到 " + cards + " 张设定卡）" : "") : "✅ 演化检测：无新演化");
        } catch (e) { results.push("⚠ 演化检测失败：" + e.message); }
      }
      // 4) 未回收伏笔提醒
      if (!skip.includes("foreshadow")) {
        try {
          const fore = JSON.parse(await engine.readText("foreshadowing.json"));
          const un = (fore.entries || []).filter(function (x) { return !x.resolvedIn; });
          results.push(un.length ? "⚠ 未回收伏笔 " + un.length + " 条：" + un.map(function (x) { return x.name; }).join("、") : "✅ 伏笔全部回收");
        } catch (e) {}
      }
      // 5) 活目录刷新（自动归纳章节/字数/状态/摘要）
      if (!skip.includes("catalog")) {
        try {
          const cat = await engine.rebuildCatalog();
          results.push("✅ 活目录已刷新（chapters/INDEX.md：" + cat.chapters + " 章 / " + cat.volumes + " 卷）");
        } catch (e) { results.push("⚠ 目录刷新失败：" + e.message); }
      }
      return "章末编排（" + label + "）：\n" + results.map(function (r) { return "- " + r; }).join("\n");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_embed",
    description: "为项目（lore/outline/chapters）与书库构建或补全语义向量索引，启用真正的「按含义」检索。增量、可断点续传：已嵌入的跳过，内容改过的自动重嵌。无向量时 novel_semantic/novel_vsearch 自动退化为字面检索。",
    parameters: {
      target: { type: "string", enum: ["project", "library", "all"], description: "嵌入目标：project 项目 / library 书库 / all 全部。默认 all" },
      novelId: { type: "string", description: "仅嵌入书库中某一本的 id（配合 target=library 使用）" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const target = args.target || "all";
      const lines = [];
      if (target === "project" || target === "all") {
        const stats = await engine.embedMissing({ cap: 1000000 });
        const projMsg = stats.reason === "llm-concepts" || stats.reason === "llm-concepts-fallback"
          ? ("概念索引（DeepSeek）新嵌 " + stats.embedded + " 篇 / 词表 " + (stats.vocab !== undefined ? stats.vocab + " 词" : "已建") + (stats.skipped ? "，跳过 " + stats.skipped : "") + (stats.failed ? "，失败 " + stats.failed : ""))
          : (stats.reason ? stats.reason : ("新嵌 " + stats.embedded + " 篇 / " + stats.chunks + " 块" + (stats.failed ? "，失败 " + stats.failed : "") + (stats.remaining ? "，剩余 " + stats.remaining : "，已全部嵌入")));
        lines.push("项目：" + projMsg);
      }
      if (target === "library" || target === "all") {
        let stats;
        if (args.novelId) stats = await library.embedNovel(args.novelId);
        else stats = await library.embedAll();
        let libMsg = "处理 " + stats.novels + " 本";
        if (stats.reason === "llm-concepts-fallback") libMsg += " / 概念索引新嵌 " + stats.embedded + " 章（embedding 不可用，已自动降级）";
        else libMsg += " / 新嵌 " + stats.embedded + " 章 / " + stats.chunks + " 块" + (stats.failed ? "，失败 " + stats.failed : "");
        lines.push("书库：" + (stats.error ? stats.error : libMsg));
      }
      return "向量嵌入完成：\n" + lines.map(function (l) { return "- " + l; }).join("\n") + "\n\n此后 novel_semantic 按「含义」检索（向量召回 + 字面召回 + LLM 重排），novel_vsearch 可查看纯向量命中与相似度。";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_vsearch",
    description: "纯向量语义检索：按含义相似度（cosine）在项目与书库中检索，不调用 LLM，返回带相似度分数的片段。适合快速验证语义召回质量；若尚无向量（未运行 novel_embed），返回提示。",
    parameters: {
      query: { type: "string", required: true, description: "检索意图/句子，如 主角心灰意冷想要放弃" },
      limit: { type: "integer", description: "每个来源返回条数，默认 6" },
      scope: { type: "string", enum: ["both", "project", "library"], description: "检索范围，默认 both" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const limit = Math.min(20, Math.max(1, args.limit || 6));
      const scope = args.scope || "both";
      const lines = [];
      if (scope === "both" || scope === "project") {
        const hits = await engine.vectorSearch(args.query, { limit: limit });
        if (hits === null) {
          lines.push("【项目】暂无向量索引（用 novel_embed 构建后即可按含义检索）");
        } else {
          lines.push("【项目】" + hits.length + " 条：");
          for (const h of hits) lines.push("- " + h.score + " | " + h.rel + "\n  " + h.snippet.replace(/\n/g, " "));
        }
      }
      if (scope === "both" || scope === "library") {
        const lv = await library.vectorSearch(args.query, limit);
        if (lv === null) {
          lines.push("【书库】暂无向量索引（用 novel_embed 构建后即可按含义检索）");
        } else {
          lines.push("【书库】" + lv.total + " 条：");
          for (const x of lv.results) lines.push("- " + x.score + " | 《" + x.novelTitle + "》\n  " + x.snippet.replace(/\n/g, " "));
        }
      }
      return lines.join("\n");
    }
  }));

  // ── 新增：用量总账 / 机械校对 / 连载计划（本地架子）──
  ctx.tools.register(defineTool({
    name: "novel_usage",
    description: "查看写文引擎（独立分流 key）的用量总账：调用次数、输入/输出 token、缓存命中、估算费用，按模型与最近 7 天汇总。",
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      return usageReport();
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_proofread",
    description: "机械校对：检查章节正文的错别字、标点误用、的地得混用、重复用词、数字格式等硬伤，输出修改清单。不重写正文、不改文风。",
    parameters: {
      chapterId: { type: "string", required: true, description: "章节 id（如 ch012）或相对路径" },
      focus: { type: "string", description: "重点检查项（可选：错别字/标点/的地得/重复词/数字格式）" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      let rel = null;
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      const hit = chapters.find(function (c) { return c.id === args.chapterId; });
      if (hit && hit.path) rel = hit.path;
      else if (/^chapters\//.test(String(args.chapterId))) rel = String(args.chapterId);
      else rel = "chapters/" + String(args.chapterId) + ".md";
      let text;
      try { text = await engine.readText(rel); } catch (e) { return "章节不存在: " + rel; }
      const focus = args.focus || "错别字、标点误用、的地得混用、重复用词、数字与格式硬伤";
      const report = await engine.generate({
        system: "你是严格的中文校对编辑。只找机械性硬伤（错别字、标点误用、的地得混用、重复用词、数字格式、引号配对），输出修改清单；绝不改写文风、不润色、不重写句子。",
        prompt: "【检查重点】" + focus + "\n\n【正文】\n" + text + "\n\n请逐条列出发现的问题，格式：片段 | 问题类型 | 建议改为。没有发现就写「未发现硬伤」。不要输出原文全文。",
        signal: exec && exec.signal
      });
      return "校对报告（" + rel + "）：\n" + report;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_plan",
    description: "连载计划（本地架子）：设定完本目标（章数/字数/日期）、查看进度与存稿余量、每日产出计划、登记排期。不做平台对接，发布由作者在平台自行粘贴。",
    parameters: {
      action: { type: "string", required: true, description: "view | set-goal | schedule | mark-done" },
      targetChapters: { type: "integer", description: "set-goal：目标总章数" },
      targetWords: { type: "integer", description: "set-goal：目标总字数" },
      endDate: { type: "string", description: "set-goal：完本日期 YYYY-MM-DD" },
      date: { type: "string", description: "schedule / mark-done：日期 YYYY-MM-DD" },
      plan: { type: "string", description: "schedule：当日计划描述" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const plan = await planLoad(engine);
      const action = args.action || "view";
      if (action === "set-goal") {
        plan.goal = plan.goal || {};
        if (args.targetChapters !== undefined) plan.goal.targetChapters = args.targetChapters;
        if (args.targetWords !== undefined) plan.goal.targetWords = args.targetWords;
        if (args.endDate) plan.goal.endDate = args.endDate;
        await planSave(engine, plan);
        return "目标已更新。\n" + planView(manifest, plan);
      }
      if (action === "schedule") {
        if (!args.date || !args.plan) return "需要 date 与 plan";
        plan.schedule = Array.isArray(plan.schedule) ? plan.schedule : [];
        plan.schedule.push({ date: args.date, plan: args.plan, done: false });
        await planSave(engine, plan);
        return "已登记排期。\n" + planView(manifest, plan);
      }
      if (action === "mark-done") {
        if (!args.date) return "需要 date";
        plan.schedule = Array.isArray(plan.schedule) ? plan.schedule : [];
        const s = plan.schedule.find(function (x) { return x.date === args.date; });
        if (s) s.done = true;
        await planSave(engine, plan);
        return planView(manifest, plan);
      }
      return planView(manifest, plan);
    }
  }));

}