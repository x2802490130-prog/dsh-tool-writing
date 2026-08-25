import { defineTool as baseDefineTool } from "@deepseek-ai/dsh-tools";
import { countWords } from "./engine.js";
import { report as usageReport } from "./usage.js";
import { planLoad, planSave, planView } from "./plan.js";
import { generateOptions } from "./choice.js";
import { loadCharacters, saveCharacters, charactersContext } from "./characters.js";
import { loadWorldState, worldStateContext } from "./worldstate.js";
import { autoProof } from "./autoproof.js";
import { runSync } from "./sync.js";
import { splitFrontMatter, renderCard, writeLoreCard, appendEvolutionToCard, cardInjectText } from "./card.js";
import { SqliteIndex } from "./sqlite-index.js";

export { splitFrontMatter, renderCard, writeLoreCard, appendEvolutionToCard, gatherContext, buildWritingBrief, chapterNumberFromId, normalizeHeading };

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
  // 故事承诺书注入（outline/premise.md：全书的题，永不违反——所有写作档位强制携带；
  // 大纲是路标可修订，修订不得违背承诺。缺文件时静默跳过，不阻断）
  try {
    const premise = await engine.readText("outline/premise.md");
    if (premise && premise.trim()) {
      parts.push("");
      parts.push("【故事承诺书（全书的题，永不违反；大纲是路标可修订，修订不得违背承诺）】");
      parts.push(premise.slice(0, 4000));
    }
  } catch (e) {}
  if (opts.lore !== false) {
    const files = await engine.listFiles("lore");
    const systemFiles = ["other/plot-log.md", "other/inbox.md", "other/conflicts.md"];
    // 只注入真正的设定卡：排除系统文件、README、风格档案、json、以及 memes/styles 等工具性目录
    // （否则梗库/取材原文会挤占 minimal 的 20 卡配额，world 设定一张都进不去）
    const cards = files.filter(function (f) {
      if (systemFiles.indexOf(f) >= 0) return false;
      if (f.indexOf("README") >= 0) return false;
      if (/^other\/[^/]*-profile\.md$/.test(f)) return false;
      if (/\.json$/.test(f)) return false;
      if (f.indexOf("memes/") >= 0 || f.indexOf("styles/") >= 0) return false;
      if (/^other\/[^/]*\.txt$/.test(f)) return false;
      return true;
    });
    // 设定卡无限制注入：卡是书自己的资产，书越写卡越多，配额会挤掉后期重要卡。
    // 每卡截头部 400 字（+front-matter summary），全量注入；token 成本由 Flash 兜底，不设限。
    const maxCards = cards.length;
    if (cards.length) {
      parts.push("");
      parts.push(level === "full" ? "【已有设定】" : "【设定摘要（卡片截取头部，细节用 novel_lore get 查看）】");
      for (const f of cards.slice(0, maxCards)) {
        try {
          const raw = await engine.readText("lore/" + f);
          // 有 summary 用一句话摘要（关键设定不再依赖"恰好在头部"）；无则截正文头部 400
          const cardTxt = level === "full" ? splitFrontMatter(raw).body : cardInjectText(raw, 400);
          if (cardTxt.trim()) parts.push("--- " + f + " ---\n" + cardTxt);
        } catch (e) {}
      }
    }
  }
  // 情节摘要注入（所有档位：写正文的记忆锚，minimal 也不可缺，防跨章事实断链）
  if (opts.lore !== false) {
    try {
      const log = await engine.readText("lore/other/plot-log.md");
      const tail = level === "full" ? log.slice(-4000) : log.slice(-2500);
      if (tail.trim()) parts.push("", "【情节摘要（近期，写作前必读）】", tail);
    } catch (e) {}
  }
  // 世界状态层注入（称谓/物证/地点的事实锚点，防内部漂移）
  try {
    const wsCtx = worldStateContext(await loadWorldState(engine));
    if (wsCtx) parts.push("", wsCtx);
  } catch (e) {}
  if (opts.outline !== false) {
    // premise.md 由「故事承诺书」段专管，此处排除避免重复注入
    const files = (await engine.listFiles("outline")).filter(function (x) { return x !== "premise.md"; });
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
  // 追读力注入：近章钩子/爽点/欠账（上一章欠账未回应前，本章不许开新钩子）
  try {
    const ledgerTxt = await engine.readText("lore/other/ledger.md");
    const pullIdx = ledgerTxt.indexOf("## 追读力");
    if (pullIdx >= 0) {
      const pullSection = ledgerTxt.slice(pullIdx, pullIdx + 1200);
      if (pullSection.trim()) parts.push("", "【追读力（近章钩子/爽点/欠账——上一章欠账未回应前，本章不许开新钩子；每 600-900 字给一次微兑现）】", pullSection);
    }
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
  // 指纹注入：风格/叙事技法/爽点/架构四类 profile（饲料区功能性蒸馏产物），全部注入
  const profileTitles = {
    "other/style-profile.md": "【作者风格指纹（写作时严格遵守）】",
    "other/technique-profile.md": "【叙事技法示范（参考其手法写本章：节奏有打断、人物有内心、配角有剩余人格、物象分层揭开、钩子不重复）】",
    "other/fun-profile.md": "【爽点技法示范（本章若有冲突/压制/反转情节，参考其节奏与期待感管理）】",
    "other/architecture-profile.md": "【架构技法示范（设定释放节奏、伏笔埋设、多线交织、氛围营造）】"
  };
  try {
    const pfFiles = await engine.listFiles("lore");
    for (const f of pfFiles) {
      if (!profileTitles[f]) continue;
      try {
        const txt = await engine.readText("lore/" + f);
        if (txt && txt.trim()) {
          parts.push("");
          parts.push(profileTitles[f]);
          parts.push(txt);
        }
      } catch (e) {}
    }
  } catch (e) {}
  // 全局技法库注入（跨项目：对话/职业/能力感官/开篇/地方志/大纲成长/人味，每卡截取头部控 token）
  try {
    const gtech = await engine.readGlobalTechniques();
    for (const card of gtech) {
      if (!card.text || !card.text.trim()) continue;
      parts.push("");
      parts.push("【全局技法卡：" + card.file.replace(/\.md$/, "") + "】");
      parts.push(card.text.slice(0, 700));
    }
  } catch (e) {}
  // 标杆笔法约束：书库拆解沉淀的笔法卡（lore/other/benchmarks/*.md），生成时对照执行
  try {
    const bm = await engine.listFiles("lore/other/benchmarks");
    const bmParts = [];
    for (const f of bm) {
      try {
        const t = await engine.readText("lore/other/benchmarks/" + f);
        if (t && t.trim()) bmParts.push("--- " + f + " ---\n" + t.slice(0, 4000));
      } catch (e) {}
    }
    if (bmParts.length) {
      parts.push("", "【标杆笔法约束（写作时逐条对照执行，不许违反）】");
      parts.push(bmParts.join("\n\n"));
    }
  } catch (e) {}
  // 章前四查（ch001 打磨复盘沉淀：物理/信息/动机/视角——写正文前逐条对照）
  parts.push("", "【章前四查（写正文时逐条对照，防止初稿返工）】", [
    "① 物理查：位置（人物在哪/离目标多远/看得见吗）、光线（灯/火/月光——看得清吗）、道具状态（牌在怀里还是摊开——后文动作依赖的状态）、时间（白天/夜里/几更——与前后文锚定）。",
    "② 信息查：本章人物知道什么/不知道什么（对照正典台账）；这条信息之前给过没有（数字/母题禁止重复给）；每段对话必须改变什么（警告要有后果，承认要有回应）。",
    "③ 动机查：每个动作，人物为什么做？（答不上来的动作不写）；每个念头，为什么出现在这个人脑子里？（无来源的念头是作者硬塞）。",
    "④ 视角查：本章谁的视角（第三人称限知——贴谁就全是谁的）；拉远景必须有传导（动作收束/时间流逝/环境过渡——不是'他抬眼看到'）；比喻先问能否从人物身体里长出来（长不出就是作者腔）。"
  ].join("\n"));
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

// 技法提醒：饲料区四份指纹（战略级天使叙事技法/斗破斗罗爽点机制/诡秘架构）的核心压缩，
// 每次生成注入任务段之前（recency 最强处），让蒸馏真正进入写作而非躺在卡里。
const WRITING_CUES = "\n\n【写作提醒（技法沉淀，自然融入，勿生硬套用）】\n1. 节奏：本章至少一次自我打断——视角内转、时间跳切、情绪急停或话语中断。\n2. 人物：主角要有内在声音（心里反驳、掂量、迟疑、没说出口的话）；出场的配角带一点与主线无关的生活细节。\n3. 物象：线索分层揭开，不一次说尽；已揭示的信息不重复罗列。\n4. 张力：信息揭示要有延迟满足；若有反转，先压制再释放。\n5. 规则：共情能力有层级与代价，随剧情自然体现，不一次性讲完。\n6. 钩子：章节结尾的钩子换类型，不与上一章重复。";

// 五段写作任务书（步骤 5：写前想透再写）——借鉴 webnovel-writer context-agent 设计：
// 开篇委托 / 这章的故事（目标·阻力·必须覆盖·禁区）/ 这章的人物 / 怎么写更顺 / 收在哪里。
// 特别强调第 5 段"收在哪里"：结尾停什么感觉、留什么未完感——决定读者要不要点下一章。
async function buildWritingBrief(engine, opts) {
  const { charCtx, context, num, target, title, instruction, mode, exec } = opts;
  const brief = await engine.generate({
    keyRole: "draft",
    maxTokens: 4000,
    system: "你是长篇小说的写作参谋。动笔前把一章想透，输出五段写作任务书给起草阶段执行。只输出任务书正文，不写正文、不写小说语言。",
    prompt: "基于以下上下文与作者提示，输出五段写作任务书：\n1. 开篇委托：本章编号（第" + (num || "N") + "章）、标题参考、一句话目标（本章要推进什么：目标/代价/关系，至少一项）。\n2. 这章的故事：本章目标、主要阻力、必须覆盖的节点、禁区（不许发生什么——对照【未回收伏笔】与【追读力】，禁止提前摊牌、禁止违背故事承诺书）。\n3. 这章的人物：每个出场人物一段——当前状态、此刻想要什么、本章作用、说话倾向（对白带潜台词，不说全）。\n4. 怎么写更顺：风格与节奏要点（对照笔法约束与 Anti-AI 清单：删感悟、删副词、情绪用生理反应）、需要回应的前文钩子/欠账、微兑现安排（每 600-900 字一次）。\n5. 收在哪里（最重要）：结尾停在什么感觉上、留什么未完感——收在物象上，不总结。\n\n【上下文】\n" + (charCtx ? charCtx + "\n" : "") + context + "\n\n【作者提示】" + (mode === "continue" ? "本章是续写章。" : "本章是常规起草章。") + (title ? " 标题参考：" + title + "。" : "") + (instruction ? " " + instruction : "") + " 目标字数约 " + (target || 2000) + " 字。",
    signal: exec && exec.signal
  });
  return String(brief || "").trim();
};

// 从章节 id 提取真实序号（ch012→12，vol01-ch001→1，chapter7→7）
function chapterNumberFromId(id) {
  const m = String(id || "").match(/(?:ch|chapter)?[-_]?0*(\d+)$/i);
  return m ? parseInt(m[1], 10) : null;
}

// 标题行规范化：正文首行统一为「## 第N章 标题」（N 为真实序号，不再由模型猜测）。
// 提取模型给出的标题文字；若正文无标题行则插入行首。
function normalizeHeading(text, n, fallbackTitle) {
  const s = String(text || "").replace(/^\ufeff/, "");
  const lines = s.split(/\r?\n/);
  const first = lines[0] || "";
  let title = "";
  if (/^#+\s/.test(first)) {
    const m = first.match(/^#+\s*(?:第?\s*[0-9一二三四五六七八九十百千零]+\s*[章节回]\s*[:：]?\s*)?(.*?)\s*$/);
    if (m) title = m[1].trim();
  }
  if (!title) title = String(fallbackTitle || "").trim();
  const heading = "## " + (n ? "第" + n + "章" : "") + (title ? " " + title : "");
  if (/^#+\s/.test(first)) {
    lines[0] = heading;
    return lines.join("\n");
  }
  return heading + "\n" + s;
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

async function semanticRecall(engine, library, query, limit, exec) {
  let terms = [query];
  try {
    const expanded = await engine.generate({
      keyRole: "sync",
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
  // 概念索引（DeepSeek LLM 概念词）：无向量/向量失败时的"按含义"召回
  tasks.push(engine.conceptSearch(query, 6).then(function (ch) { return { kind: "pc", hits: ch }; }).catch(function () { return null; }));
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
    } else if (o.kind === "pc") {
      for (const h of o.hits) {
        const key = "pc:" + h.rel;
        if (seen.has(key)) continue; seen.add(key);
        candidates.push({ source: "项目(概念)", rel: h.rel, snippet: h.snippet, score: h.score });
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
      keyRole: "sync",
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

// 定位台账表的数据区起点：跳过「标题行 + 空行 + 表头行 + 分隔线行」；定位失败返回 -1
function tableInsertAt(existing, hIdx) {
  let cursor = hIdx;
  for (let i = 0; i < 4; i++) {
    const nl = existing.indexOf("\n", cursor);
    if (nl < 0) return -1;
    cursor = nl + 1;
  }
  return cursor;
}

export function registerWritingTools(ctx, engine, library) {
  // 工具执行上下文注入：宿主在 exec.agent.session 里给出「当前会话」（与 todo/bash 等
  // 宿主工具一致）。引擎是预设级单例（多会话共享），root 按会话惰性解析——
  // 这里在每次工具调用前把当前会话喂给引擎，保证 novel_* 落在本会话的工作区目录。
  const defineTool = (def) => {
    const tool = baseDefineTool(def);
    if (typeof tool.execute === "function") {
      const origExecute = tool.execute;
      tool.execute = (args, exec) => {
        try { engine.setExecContext(exec); } catch (e) {}
        return origExecute(args, exec);
      };
    }
    return tool;
  };
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
      const results = await engine.generateMany(tasks, { keyRole: "draft", maxTokens: 12000, signal: exec && exec.signal });
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
          keyRole: "draft",
        maxTokens: 20000,
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
        const results = await engine.generateMany(tasks, { keyRole: "draft", maxTokens: 12000, signal: exec && exec.signal });
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
          keyRole: "sync",
          maxTokens: 20000,
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
      targetWords: { type: "integer", description: "目标字数（中文），默认 2000" },
      brief: { type: "boolean", description: "写前先出五段写作任务书（想透再写，尤其定死'收在哪里'；多一次调用，默认 false）" },
      gate: { type: "boolean", description: "写完自动过阻断质检（事实矛盾/承诺违背/欠账未回应/物理硬伤），有问题自动修复一轮再落盘（多 1-2 次调用，默认 false）" },
      sync: { type: "boolean", description: "写完后自动跑章末记忆维护（摘要/设定抽取/人物与世界状态回写），默认 true" },
      proofread: { type: "boolean", description: "写完后自动机械校对（错字/人名/称谓，确定硬伤就地修复），默认 true" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const target = args.targetWords || 2000;
      const num = chapterNumberFromId(args.chapterId);
      const context = await gatherContext(engine, { level: "minimal", recentChapters: 2 });
      const charCtx = charactersContext(await loadCharacters(engine));
      let briefBlock = "";
      if (args.brief) {
        try {
          const b = await buildWritingBrief(engine, { charCtx: charCtx, context: context, num: num, target: target, title: args.title, instruction: args.instruction, mode: "draft", exec: exec });
          if (b) briefBlock = "\n\n【写作任务书（按此起草；尤其遵守第 5 段'收在哪里'；冲突时以作者提示与故事承诺书为准）】\n" + b;
        } catch (e) { briefBlock = ""; }
      }
      const text = await engine.generate({
        keyRole: "draft",
        maxTokens: 20000,
        system: "你是写长篇小说的。以人物视角写作：进入主要人物此刻的所知、所感与欲望，用场景、对话与行动呈现。白描克制：环境一笔带过，比喻少而准，让动作与对话推进故事。人物要有内在声音——在心里反驳、掂量、迟疑，说出没说出口的话；配角出场带一点与主线无关的生活细节；物象线索分层揭开，不一次说尽。",
        prompt: charCtx + context + WRITING_CUES + briefBlock + "\n\n【本章】" + (args.title ? "标题参考：" + args.title + "。" : "") + (args.instruction ? "作者提示：" + args.instruction + "。" : "从人物当下的处境自然推演。") + " 写到这场戏自然收束（约 " + target + " 字上下，不必凑数）。第一行输出章节标题（2-8字，提炼本章核心），格式 ## " + (num ? "第" + num + "章" : "第N章") + " 标题。",
        signal: exec && exec.signal
      });
      let finalText = normalizeHeading(text, num, args.title);
      const vol = args.volume ? safeName(args.volume) : "";
      const rel = "chapters/" + (vol ? vol + "/" : "") + args.chapterId + ".md";
      const maint = [];
      if (args.proofread !== false) {
        try {
          const names = (await loadCharacters(engine)).characters.map(function (c) { return c.name; }).filter(Boolean);
          const pr = await autoProof(engine, { chapterId: args.chapterId, text: finalText, names: names, signal: exec && exec.signal });
          if (pr.text && pr.text !== finalText) finalText = normalizeHeading(pr.text, num, args.title);
          maint.push("自动校对：修复 " + pr.fixed + " 处硬伤" + (pr.applied && pr.applied.length ? "（" + pr.applied.join("；") + "）" : "") + (pr.notes ? "，另有 " + pr.notes + " 条建议 → " + pr.noteRel : "") + (pr.error ? "｜⚠ " + pr.error : ""));
        } catch (e) { maint.push("自动校对：⚠ " + e.message); }
      }
      // 硬关卡（gate 模式）：阻断质检——事实矛盾/承诺违背/欠账未回应/物理硬伤，有问题自动修复一轮
      if (args.gate) {
        try {
          let premise = ""; try { premise = await engine.readText("outline/premise.md"); } catch (e) {}
          const gateCheck = await engine.generate({
            keyRole: "draft",
            maxTokens: 4000,
            system: "你是严格的连载质检员。判断草稿是否有必须修改的阻断级问题。只输出 JSON，不输出其他文字。",
            prompt: "检查以下草稿的阻断级问题：①事实矛盾（数字/时间/信息来源与正文自洽）②违背故事承诺书 ③上一章欠账/钩子未回应 ④物理/视角硬伤（人物位置/光线/道具状态/时间锚）。只列阻断级（严重到不改不能发）的问题，小瑕疵不列。\n\n输出 JSON：{\"blocking\": true/false, \"issues\": [\"问题1\", \"问题2\"]}\n\n【故事承诺书】\n" + (premise || "（无）").slice(0, 2000) + "\n\n【草稿】\n" + finalText.slice(0, 6000),
            json: true,
            signal: exec && exec.signal
          });
          let g = {};
          try { g = JSON.parse(String(gateCheck).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()); } catch (e) {}
          if (g && g.blocking && Array.isArray(g.issues) && g.issues.length) {
            const fixed = await engine.generate({
              keyRole: "draft",
              maxTokens: 20000,
              system: "你是写长篇小说的。根据质检问题清单修复草稿：只修列出的问题，不重写全文、不新增情节、保持文风与结构。",
              prompt: "【质检问题】\n- " + g.issues.join("\n- ") + "\n\n【草稿】\n" + finalText + "\n\n输出修复后的完整正文（仅输出正文）。",
              signal: exec && exec.signal
            });
            finalText = normalizeHeading(fixed, num, args.title);
            maint.push("硬关卡：发现 " + g.issues.length + " 个阻断级问题，已自动修复一轮（" + g.issues.join("；") + "）");
          } else if (g && g.blocking === false) {
            maint.push("硬关卡：通过（无阻断级问题）");
          } else {
            maint.push("硬关卡：⚠ 质检结果无法解析，跳过");
          }
        } catch (e) { maint.push("硬关卡：⚠ " + e.message); }
      }
      await engine.writeText(rel, finalText);
      const titleM = finalText.match(/^##\s*第?\s*[0-9一二三四五六七八九十百千零]+\s*[章节回]\s*[:：]?\s*([^\n]*)/);
      const title = titleM ? titleM[1].trim() : (args.title || "");
      await recordChapter(engine, args.chapterId, title, countWords(finalText), rel, args.volume);
      if (args.sync !== false) {
        try {
          const r = await runSync(engine, { chapterId: args.chapterId, skip: ["evolution"], signal: exec && exec.signal });
          maint.push("自动维护：✅ " + r.results.filter(function (x) { return x.status === "ok"; }).map(function (x) { return x.step; }).join("/") + (r.results.some(function (x) { return x.status === "error"; }) ? "（失败：" + r.results.filter(function (x) { return x.status === "error"; }).map(function (x) { return x.step; }).join("/") + "）" : ""));
        } catch (e) { maint.push("自动维护：⚠ " + e.message); }
      }
      const bodyLen = countWords(finalText.replace(/^#+\s*[^\n]*\n/, ""));
      return "已起草并保存章节：" + rel + "（" + countWords(finalText) + " 字）\n\n开头预览：\n" + preview(finalText, 240) + "\n\n（正文已保存到文件，可用 read 工具读取全文）" + (bodyLen < 100 ? "\n\n⚠ 正文异常短（去标题后 " + bodyLen + " 字），请检查是否需要重写" : "") + (maint.length ? "\n\n" + maint.join("\n") : "");
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_continue",
    description: "续写：从最近一章的结尾自然续写下一章（自动读取大纲+设定+前文），自动编号并保存，更新进度。",
    parameters: {
      targetWords: { type: "integer", description: "目标字数，默认 2000" },
      instruction: { type: "string", description: "续写方向/要点（可选，缺省按大纲自然推进）" },
      brief: { type: "boolean", description: "写前先出五段写作任务书（想透再写，尤其定死'收在哪里'；多一次调用，默认 false）" },
      gate: { type: "boolean", description: "写完自动过阻断质检（事实矛盾/承诺违背/欠账未回应/物理硬伤），有问题自动修复一轮再落盘（多 1-2 次调用，默认 false）" },
      volume: { type: "string", description: "分卷名（可选）" },
      sync: { type: "boolean", description: "写完后自动跑章末记忆维护（摘要/设定抽取/人物与世界状态回写），默认 true" },
      proofread: { type: "boolean", description: "写完后自动机械校对（错字/人名/称谓，确定硬伤就地修复），默认 true" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目，请先 novel_init）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      const chapterId = "ch" + String(chapters.length + 1).padStart(3, "0");
      const num = chapters.length + 1;
      const target = args.targetWords || 2000;
      const context = await gatherContext(engine, { level: "minimal", recentChapters: 2 });
      const charCtx = charactersContext(await loadCharacters(engine));
      let briefBlock = "";
      if (args.brief) {
        try {
          const b = await buildWritingBrief(engine, { charCtx: charCtx, context: context, num: num, target: target, title: null, instruction: args.instruction, mode: "continue", exec: exec });
          if (b) briefBlock = "\n\n【写作任务书（按此起草；尤其遵守第 5 段'收在哪里'；冲突时以作者提示与故事承诺书为准）】\n" + b;
        } catch (e) { briefBlock = ""; }
      }
      const text = await engine.generate({
        keyRole: "draft",
        maxTokens: 20000,
        system: "你是写长篇小说的。以人物视角写作：进入主要人物此刻的所知、所感与欲望，用场景、对话与行动呈现。白描克制：环境一笔带过，比喻少而准，让动作与对话推进故事。人物要有内在声音——在心里反驳、掂量、迟疑，说出没说出口的话；配角出场带一点与主线无关的生活细节；物象线索分层揭开，不一次说尽。",
        prompt: (charCtx ? charCtx + "\n" : "") + context + WRITING_CUES + briefBlock + "\n\n【续写】从上一章结尾处，以人物自己的选择推演接下来发生的事" + (args.instruction ? "（作者提示：可以朝这个方向：" + args.instruction + "）" : "") + "。写到这场戏自然收束（约 " + target + " 字上下，不必凑数）。第一行输出章节标题（2-8字，提炼本章核心），格式 ## 第" + num + "章 标题。",
        signal: exec && exec.signal
      });
      // 标题回退链：正文标题行 → instruction 中的《X》→ 空
      let fallbackTitle = "";
      const mi = String(args.instruction || "").match(/《([^》]+)》/);
      if (mi) fallbackTitle = mi[1].trim();
      let finalText = normalizeHeading(text, num, fallbackTitle);
      const vol = args.volume ? safeName(args.volume) : "";
      const rel = "chapters/" + (vol ? vol + "/" : "") + chapterId + ".md";
      const maint = [];
      if (args.proofread !== false) {
        try {
          const names = (await loadCharacters(engine)).characters.map(function (c) { return c.name; }).filter(Boolean);
          const pr = await autoProof(engine, { chapterId: chapterId, text: finalText, names: names, signal: exec && exec.signal });
          if (pr.text && pr.text !== finalText) finalText = normalizeHeading(pr.text, num, fallbackTitle);
          maint.push("自动校对：修复 " + pr.fixed + " 处硬伤" + (pr.applied && pr.applied.length ? "（" + pr.applied.join("；") + "）" : "") + (pr.notes ? "，另有 " + pr.notes + " 条建议 → " + pr.noteRel : "") + (pr.error ? "｜⚠ " + pr.error : ""));
        } catch (e) { maint.push("自动校对：⚠ " + e.message); }
      }
      // 硬关卡（gate 模式）：阻断质检——事实矛盾/承诺违背/欠账未回应/物理硬伤，有问题自动修复一轮
      if (args.gate) {
        try {
          let premise = ""; try { premise = await engine.readText("outline/premise.md"); } catch (e) {}
          const gateCheck = await engine.generate({
            keyRole: "draft",
            maxTokens: 4000,
            system: "你是严格的连载质检员。判断草稿是否有必须修改的阻断级问题。只输出 JSON，不输出其他文字。",
            prompt: "检查以下草稿的阻断级问题：①事实矛盾（数字/时间/信息来源与正文自洽）②违背故事承诺书 ③上一章欠账/钩子未回应 ④物理/视角硬伤（人物位置/光线/道具状态/时间锚）。只列阻断级（严重到不改不能发）的问题，小瑕疵不列。\n\n输出 JSON：{\"blocking\": true/false, \"issues\": [\"问题1\", \"问题2\"]}\n\n【故事承诺书】\n" + (premise || "（无）").slice(0, 2000) + "\n\n【草稿】\n" + finalText.slice(0, 6000),
            json: true,
            signal: exec && exec.signal
          });
          let g = {};
          try { g = JSON.parse(String(gateCheck).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()); } catch (e) {}
          if (g && g.blocking && Array.isArray(g.issues) && g.issues.length) {
            const fixed = await engine.generate({
              keyRole: "draft",
              maxTokens: 20000,
              system: "你是写长篇小说的。根据质检问题清单修复草稿：只修列出的问题，不重写全文、不新增情节、保持文风与结构。",
              prompt: "【质检问题】\n- " + g.issues.join("\n- ") + "\n\n【草稿】\n" + finalText + "\n\n输出修复后的完整正文（仅输出正文）。",
              signal: exec && exec.signal
            });
            finalText = normalizeHeading(fixed, num, fallbackTitle);
            maint.push("硬关卡：发现 " + g.issues.length + " 个阻断级问题，已自动修复一轮（" + g.issues.join("；") + "）");
          } else if (g && g.blocking === false) {
            maint.push("硬关卡：通过（无阻断级问题）");
          } else {
            maint.push("硬关卡：⚠ 质检结果无法解析，跳过");
          }
        } catch (e) { maint.push("硬关卡：⚠ " + e.message); }
      }
      await engine.writeText(rel, finalText);
      const titleM = finalText.match(/^##\s*第?\s*[0-9一二三四五六七八九十百千零]+\s*[章节回]\s*[:：]?\s*([^\n]*)/);
      const title = titleM ? titleM[1].trim() : fallbackTitle;
      await recordChapter(engine, chapterId, title, countWords(finalText), rel, args.volume);
      if (args.sync !== false) {
        try {
          const r = await runSync(engine, { chapterId: chapterId, skip: ["evolution"], signal: exec && exec.signal });
          maint.push("自动维护：✅ " + r.results.filter(function (x) { return x.status === "ok"; }).map(function (x) { return x.step; }).join("/") + (r.results.some(function (x) { return x.status === "error"; }) ? "（失败：" + r.results.filter(function (x) { return x.status === "error"; }).map(function (x) { return x.step; }).join("/") + "）" : ""));
        } catch (e) { maint.push("自动维护：⚠ " + e.message); }
      }
      const bodyLen = countWords(finalText.replace(/^#+\s*[^\n]*\n/, ""));
      return "已续写并保存：" + rel + "（" + countWords(finalText) + " 字）\n\n开头预览：\n" + preview(finalText, 240) + "\n\n（正文已保存到文件，可用 read 工具读取全文）" + (bodyLen < 100 ? "\n\n⚠ 正文异常短（去标题后 " + bodyLen + " 字），请检查是否需要重写" : "") + (maint.length ? "\n\n" + maint.join("\n") : "");
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
      concurrency: { type: "integer", description: "并发数，默认取引擎配置" },
      brief: { type: "boolean", description: "每章写前先出五段写作任务书（想透再写；多 N 次调用，默认 false）" },
      sync: { type: "boolean", description: "写完后自动跑章末记忆维护，默认 true" },
      proofread: { type: "boolean", description: "写完后自动机械校对，默认 true" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const chapters = args.chapters || [];
      if (!chapters.length) return "章节列表为空";
      const context = await gatherContext(engine, { level: "minimal", recentChapters: 2 });
      const charCtx = charactersContext(await loadCharacters(engine));
      let briefs = [];
      if (args.brief) {
        try {
          briefs = await Promise.all(chapters.map(function (c) {
            return buildWritingBrief(engine, { charCtx: charCtx, context: context, num: chapterNumberFromId(c.chapterId), target: c.targetWords || 2000, title: c.title, instruction: c.instruction, mode: "draft", exec: exec }).catch(function () { return ""; });
          }));
        } catch (e) { briefs = []; }
      }
      const tasks = chapters.map(function (c, i) {
        const num = chapterNumberFromId(c.chapterId);
        const briefBlock = briefs[i] ? "\n\n【写作任务书（按此起草；尤其遵守第 5 段'收在哪里'；冲突时以作者提示与故事承诺书为准）】\n" + briefs[i] : "";
        return {
          system: "你是写长篇小说的。以人物视角写作：进入主要人物此刻的所知、所感与欲望，用场景、对话与行动呈现。白描克制：环境一笔带过，比喻少而准，让动作与对话推进故事。人物要有内在声音——在心里反驳、掂量、迟疑，说出没说出口的话；配角出场带一点与主线无关的生活细节；物象线索分层揭开，不一次说尽。",
          prompt: (charCtx ? charCtx + "\n" : "") + context + WRITING_CUES + briefBlock + "\n\n【本章任务】" + (c.title ? "标题参考：" + c.title + "。" : "") + (c.instruction ? "作者提示：" + c.instruction + "。" : "从人物当下的处境自然推演。") + " 写到这场戏自然收束（约 " + (c.targetWords || 2000) + " 字上下，不必凑数）。第一行输出章节标题（2-8字，提炼本章核心），格式 ## " + (num ? "第" + num + "章" : "第N章") + " 标题。"
        };
      });
      const results = await engine.generateMany(tasks, { keyRole: "draft", concurrency: args.concurrency, maxTokens: 12000, signal: exec && exec.signal });
      const lines = [];
      const names = (await loadCharacters(engine)).characters.map(function (c) { return c.name; }).filter(Boolean);
      for (let i = 0; i < chapters.length; i++) {
        const c = chapters[i];
        const num = chapterNumberFromId(c.chapterId);
        let finalText = normalizeHeading(String(results[i] || ""), num, c.title);
        const vol = c.volume ? safeName(c.volume) : "";
        const rel = "chapters/" + (vol ? vol + "/" : "") + c.chapterId + ".md";
        if (args.proofread !== false) {
          try {
            const pr = await autoProof(engine, { chapterId: c.chapterId, text: finalText, names: names, signal: exec && exec.signal });
            if (pr.text && pr.text !== finalText) finalText = normalizeHeading(pr.text, num, c.title);
          } catch (e) {}
        }
        await engine.writeText(rel, finalText);
        const titleM = finalText.match(/^##\s*第?\s*[0-9一二三四五六七八九十百千零]+\s*[章节回]\s*[:：]?\s*([^\n]*)/);
        const title = titleM ? titleM[1].trim() : (c.title || "");
        await recordChapter(engine, c.chapterId, title, countWords(finalText), rel, c.volume);
        if (args.sync !== false) {
          try { await runSync(engine, { chapterId: c.chapterId, skip: ["evolution"], signal: exec && exec.signal }); } catch (e) {}
        }
        lines.push("- " + c.chapterId + "：" + countWords(finalText) + " 字 → " + rel);
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
        keyRole: "polish",
        maxTokens: 20000,
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
          if (hit) { hit.status = "polished"; hit.words = countWords(polished); await engine.writeManifest(m); }
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
        keyRole: "polish",
        maxTokens: 20000,
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
        keyRole: "sync",
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
          // 去掉正文自带的标题行，导出时统一补真实序号（## 第N章 标题）
          text = String(text).replace(/^#+\s*(?:第\s*[0-9一二三四五六七八九十百千零]+\s*[章节回]|Chapter\s+\d+)[^\n]*\n/, "").replace(/^##\s*[^\n]{1,30}\n/, "").trimStart();
          const idx2 = chapters.indexOf(c);
          const num2 = idx2 >= 0 ? idx2 + 1 : chapterNumberFromId(c.id);
          const heading = (num2 ? "第" + num2 + "章 " : "") + (c.title || c.id);
          parts.push(fmt === "markdown" ? "\n### " + heading + "\n\n" + text : "\n\n" + heading + "\n\n" + text);
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
        keyRole: "sync",
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
        keyRole: "sync",
        effort: "high",
        maxTokens: 20000,
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
    description: "引导式开书：把一句话/模糊需求展开成完整开书方案（书名/简介/卖点/金手指/人设/主线大纲/读者承诺）。两脑空空时先用它：第一次调用返回澄清问题清单（带选项与影响），回答后带 answers 再调一次出完整方案；需求足够具体则直接出方案。",
    parameters: {
      premise: { type: "string", required: true, description: "一句话/一段需求，如「废柴少年逆袭成神」——多模糊都没关系，会先澄清" },
      answers: { type: "string", description: "对澄清问题的回答（第二轮调用时传，如：1.选B；2.不想要系统；3.单女主）" },
      style: { type: "string", description: "目标文风（爽文快节奏/细腻白描/冷峻悬疑…）" },
      extra: { type: "string", description: "额外要求/禁忌（如 无系统、单女主、拒绝套路）" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const premise = String(args.premise || "").trim();
      if (!premise) return "缺少 premise（一句话需求）";
      const answers = String(args.answers || "").trim();
      const styleTxt = args.style ? "\n【文风】" + args.style : "";
      const extraTxt = args.extra ? "\n【额外要求】" + args.extra : "";
      const baseReq = "【需求】" + premise + styleTxt + extraTxt;
      // 第一轮：判断是否需要澄清（两脑空空时先问准，再开书）
      let needClarify = false;
      let questions = [];
      if (!answers) {
        try {
          const analysis = await engine.generate({
            keyRole: "draft",
            maxTokens: 4000,
            system: "你是资深网文策划。判断一个开书需求是否信息充足：题材、主角、金手指、读者预期是否明确。",
            prompt: baseReq + "\n\n判断这个开书需求是否需要澄清：需求模糊（缺题材/缺主角/缺金手指/卖点不明/互相矛盾）就输出精准的澄清问题；需求足够具体可直接开书则 needClarify=false。\n\n输出 JSON：{\"needClarify\": true/false, \"questions\": [{\"q\": \"问题\", \"options\": [\"选项1\", \"选项2\", \"选项3\"], \"impact\": \"选择的影响\"}]}（questions 最多 5 个、每个 2-3 个选项；needClarify=false 时 questions 为空数组）",
            json: true,
            signal: exec && exec.signal
          });
          const a = JSON.parse(String(analysis).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
          needClarify = !!a.needClarify;
          questions = Array.isArray(a.questions) ? a.questions : [];
        } catch (e) {}
      }
      if (!answers && needClarify && questions.length) {
        const lines = [
          "这个需求还有几个关键点要先想清楚（两脑空空很正常，答完这几点开书就有了方向）。把答案带在 answers 参数里再调一次，或直接把答案发给我：",
          ""
        ];
        questions.forEach(function (q, i) {
          lines.push((i + 1) + ". " + q.q);
          if (Array.isArray(q.options) && q.options.length) lines.push("   选项：" + q.options.join(" / "));
          if (q.impact) lines.push("   影响：" + q.impact);
        });
        lines.push("", "示例：novel_brief premise=\"...\" answers=\"1.选B；2.不要系统；3.单女主\"");
        return lines.join("\n");
      }
      // 第二轮（或无需澄清）：出完整开书方案
      const brief = await engine.generate({
        keyRole: "draft",
        maxTokens: 20000,
        system: "你是资深网文策划，能把一句模糊需求展开成完整、可执行、有卖点的开书方案。",
        prompt: baseReq + (answers ? "\n【澄清答案】" + answers : "") + "\n\n请输出完整开书方案（Markdown）：\n# 书名（3 个备选）\n# 一句话简介\n# 题材与核心卖点\n# 金手指/核心设定\n# 主角人设（性格/目标/缺陷/成长弧）\n# 主线大纲（3~5 幕，含关键转折与高潮）\n# 读者承诺（这本书答应读者什么——这是写进故事承诺书的题眼）",
        signal: exec && exec.signal
      });
      let saved = "";
      try {
        const rel = "outline/brief-" + stamp() + ".md";
        await engine.writeText(rel, brief);
        saved = "\n\n（方案已保存 " + rel + "）";
      } catch (e) { saved = "\n\n（⚠ 项目骨架未就绪，方案未保存——确认开书后可用 novel_init 建骨架再重跑保存）"; }
      return brief + saved;
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
        keyRole: "sync",
        effort: "high",
        maxTokens: 20000,
system: "你是资深内容蒸馏师。把长文本压缩成结构化精华，忠实原文，不编造。",
        prompt: "请蒸馏以下内容为结构化精华（Markdown）：\n## 梗概\n## 关键人物与关系变化\n## 核心设定\n## 伏笔\n## 金句\n\n" + excerpts + (relevant ? "\n\n【全书相关上下文（语义召回，供蒸馏参考，不必照录）】\n" + relevant : "") + (args.instruction ? "\n\n侧重点：" + args.instruction : ""),
        signal: exec && exec.signal
      });
      const verify = await engine.generate({
        keyRole: "sync",
        effort: "high",
        maxTokens: 20000,
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
        keyRole: "sync",
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
        keyRole: "draft",
        maxTokens: 20000,
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
        keyRole: "sync",
        effort: "high",
        maxTokens: 20000,
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
          const chs = r.meta.chapters || [];
          if (!chs.length) return "（该书无章节）";
          const n = chs.length;
          const picks = [chs[0], chs[Math.floor(n / 2)], chs[n - 1]];
          if (n > 6) picks.push(chs[2], chs[Math.floor(n / 3)], chs[Math.floor(n * 2 / 3)]);
          for (const ch of picks) {
            const full = await library.read(args.target, ch.file);
            const t = full.text || "";
            let sample = t.slice(0, 1200);
            if (t.length > 2400) {
              const mid = Math.floor(t.length / 2);
              sample += "\n……\n" + t.slice(mid - 300, mid + 300) + "\n……\n" + t.slice(-1200);
            } else if (t.length > 1200) {
              sample += "\n……\n" + t.slice(-600);
            }
            samples.push("【" + ch.title + "】\n" + sample);
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
            let sample = text.slice(0, 1200);
            if (text.length > 2400) {
              const mid = Math.floor(text.length / 2);
              sample += "\n……\n" + text.slice(mid - 300, mid + 300) + "\n……\n" + text.slice(-1200);
            } else if (text.length > 1200) {
              sample += "\n……\n" + text.slice(-600);
            }
            samples.push("【" + c.id + "】\n" + sample);
          }
        }
        if (!samples.length) return "（无可剖析的文本）";
        const profile = await engine.generate({
          keyRole: "sync",
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
        keyRole: "polish",
        maxTokens: 20000,
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
        keyRole: "draft",
        maxTokens: 20000,
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
        excerpts.push("【" + ch.title + "】\n" + (function () {
          const t = full.text || "";
          let sample = t.slice(0, 1200);
          if (t.length > 2400) {
            const mid = Math.floor(t.length / 2);
            sample += "\n……\n" + t.slice(mid - 300, mid + 300);
            sample += "\n……\n" + t.slice(-1200);
          } else if (t.length > 1200) {
            sample += "\n……\n" + t.slice(-600);
          }
          return sample;
        })());
      }
      const focusMap = {
        all: "人物与关系、世界观与力量体系、情节骨架与转折、爽点与套路、风格与金句",
        characters: "人物与关系（动机、弧光、关系网变化）",
        world: "世界观与力量体系（规则、势力、地理）",
        plot: "情节骨架与转折（卷级梗概、高潮、钩子）",
        "爽点": "爽点与套路（打脸/升级/收获节奏、金手指用法、情绪设计）",
        style: "风格与金句（叙事视角、节奏、文风、名场面）"
      };
      let obj = null;
      let lastErr = "";
      for (let attempt = 0; attempt < 3 && !obj; attempt++) {
        try {
          const result = await engine.generate({
            keyRole: "sync",
            effort: "high",
            maxTokens: 20000,
            system: "你是资深网文拆解师。只从给定正文拆解归纳，不编造原文没有的信息，不评价好坏。",
            prompt: "拆解《" + r.meta.title + "》第 " + (start + 1) + "~" + end + " 章。侧重：" + focusMap[focus] + "。\n\n【正文】\n" + excerpts.join("\n\n") + "\n\n请输出 JSON 对象：{\"总览\":\"...\",\"人物\":\"...\",\"世界观\":\"...\",\"情节\":\"...\",\"爽点\":\"...\",\"风格\":\"...\",\"金句\":\"...\"}，各字段为 Markdown 文本；与侧重无关的字段输出空字符串。\"风格\"字段拆叙事视角/节奏/文风/对话风格/情绪曲线；\"金句\"字段摘原文名场面与金句。" + (args.instruction ? " 要求：" + args.instruction : ""),
            json: true,
            signal: exec && exec.signal
          });
          obj = JSON.parse(String(result).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
        } catch (e) {
          lastErr = String(e && e.message || e);
          if (attempt < 2) await new Promise(function (res) { setTimeout(res, 800); });
        }
      }
      if (!obj) return "拆解结果解析失败（重试 3 次仍失败，可降 batch 重试）：\n" + lastErr.slice(0, 600);
      const map = {
        "00-总览.md": obj["总览"] || "",
        "01-人物.md": obj["人物"] || "",
        "02-世界观.md": obj["世界观"] || "",
        "03-情节骨架.md": obj["情节"] || "",
        "04-爽点与套路.md": obj["爽点"] || "",
        "05-风格.md": obj["风格"] || obj["风格金句"] || "",
        "06-金句素材.md": obj["金句"] || obj["风格金句"] || ""
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
    name: "novel_ledger",
    description: "正典台账：数字锚/信息来源/时间锚/母题密度/追读力五表（跨章一致性地基）。add 登记条目 / view 查看 / scan 扫描最近章节自动更新母题计数、追读力（钩子/爽点/微兑现/欠账）并新增锚点。",
    parameters: {
      action: { type: "string", required: true, enum: ["view", "add", "scan"], description: "view 查看台账 / add 登记一条 / scan 扫描最近章节更新" },
      type: { type: "string", enum: ["number", "source", "time", "motif", "pull"], description: "add 时的类型：number 数字口径 / source 信息来源 / time 时间锚 / motif 母题 / pull 追读力" },
      subject: { type: "string", description: "add 时的条目（如：三十七=含石满仓；pull 时为钩子描述）" },
      detail: { type: "string", description: "add 时的说明（pull 时格式：爽点：…；微兑现：…；欠账：…）" },
      chapterId: { type: "string", description: "add 或 scan 的章节" },
      recent: { type: "integer", description: "scan 最近 N 章，默认 3" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const ledgerRel = "lore/other/ledger.md";
      const defaultLedger = "# 正典台账\n\n> 跨章一致性地基：数字口径/信息来源/时间锚/母题密度/追读力。novel_ledger add 登记，scan 自动更新。\n\n## 数字锚\n\n| 数字与口径 | 说明 | 章节 |\n|---|---|---|\n\n## 信息来源\n\n| 信息 | 来源（谁告诉主角） | 章节 |\n|---|---|---|\n\n## 时间锚\n\n| 事件 | 时间 | 章节 |\n|---|---|---|\n\n## 母题密度\n\n| 母题 | 累计出现 | 最近章节 |\n|---|---|---|\n\n## 追读力\n\n| 章节 | 钩子（类型·强度） | 爽点 | 微兑现 | 欠账（未兑现承诺） |\n|---|---|---|---|---|\n";
      if (args.action === "view") {
        try { return await engine.readText(ledgerRel); } catch (e) { return defaultLedger; }
      }
      if (args.action === "add") {
        const type = args.type || "number";
        const subject = String(args.subject || "").trim();
        if (!subject) return "缺少 subject（条目）";
        const detail = String(args.detail || "").trim();
        let existing = defaultLedger;
        try { existing = await engine.readText(ledgerRel); } catch (e) {}
        const tableNames = { number: "数字锚", source: "信息来源", time: "时间锚", motif: "母题密度", pull: "追读力" };
        const header = "## " + tableNames[type];
        let row;
        if (type === "pull") {
          const parts = String(detail || "").split(/[；;]/).map(function (s) { return s.trim(); });
          const cool = parts.filter(function (p) { return p.indexOf("爽点") >= 0; }).join("；") || "—";
          const payoff = parts.filter(function (p) { return p.indexOf("微兑现") >= 0; }).join("；") || "—";
          const debt = parts.filter(function (p) { return p.indexOf("欠账") >= 0; }).join("；") || "—";
          row = "| " + (args.chapterId || "—") + " | " + subject + " | " + (cool || "—") + " | " + (payoff || "—") + " | " + (debt || "—") + " |";
        } else {
          row = "| " + subject + " | " + (detail || "—") + " | " + (args.chapterId || "—") + " |";
        }
        const hIdx = existing.indexOf(header);
        if (hIdx < 0) return "台账缺少表头：" + header;
        const insertAt = tableInsertAt(existing, hIdx);
        if (insertAt < 0) return "台账格式异常";
        existing = existing.slice(0, insertAt) + row + "\n" + existing.slice(insertAt);
        await engine.writeText(ledgerRel, existing);
        return "已登记「" + tableNames[type] + "」：" + subject;
      }
      if (args.action === "scan") {
        let manifest = {};
        try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目）"; }
        const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
        const targets = chapters.slice(-Math.max(1, args.recent || 3));
        if (!targets.length) return "（无章节可扫）";
        const texts = [];
        for (const c of targets) { let t = ""; try { t = await engine.readText(c.path); } catch (e) {} texts.push("【" + c.id + "】\n" + t.slice(-2500)); }
        // 带上 targets 前一章的结尾，用于"上一章钩子是否被回应"的检测
        const firstIdx = chapters.indexOf(targets[0]);
        if (firstIdx > 0) { const prev = chapters[firstIdx - 1]; let t = ""; try { t = await engine.readText(prev.path); } catch (e) {} texts.unshift("【" + prev.id + "（上一章结尾）】\n" + t.slice(-800)); }
        const parsed = await engine.generate({
          maxTokens: 20000,
          system: "你是正典台账员。只从给定正文提取信息，不编造。",
          prompt: "扫描以下章节正文，提取：①出现的关键数字及其口径（如'三十七'指什么，含不含某人）②主角获得的新信息及其来源（谁告诉/哪里看到）③时间变化（季节/日子/雾季状态）④关键母题（数字/意象/句式）的出现次数 ⑤每章的追读力：章末钩子的类型（悬念钩/反转钩/情感钩/秘密钩/信息钩）与强度（强/中/弱）及一句话内容；本章爽点模式（信息差/揭示/打脸/账记下了等）；微兑现（回应了前文哪一处，写明对应章节）；欠账（本章未兑现的承诺；并检查本章开头是否回应了上一章结尾的钩子——未回应则把该钩子记入欠账）。\n\n输出 JSON：{\"numbers\":[{\"subject\":\"数字与口径\",\"detail\":\"说明\"}],\"sources\":[{\"subject\":\"信息\",\"detail\":\"来源\"}],\"times\":[{\"subject\":\"事件\",\"detail\":\"时间\"}],\"motifs\":[{\"subject\":\"母题\",\"count\":出现次数}],\"pulls\":[{\"chapter\":\"章号\",\"hook\":\"类型(强度)：内容\",\"cool\":\"爽点模式\",\"payoff\":\"微兑现\",\"debt\":\"欠账\"}]}；没有的数组输出空数组。\n\n【正文】\n" + texts.join("\n\n"),
          json: true,
          signal: exec && exec.signal
        });
        let obj = {};
        try { obj = JSON.parse(String(parsed).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()); } catch (e) { return "扫描结果解析失败（输出：" + String(parsed).slice(0, 200) + "）：请重试或检查 maxTokens。"; }
        let existing = defaultLedger;
        try { existing = await engine.readText(ledgerRel); } catch (e) {}
        const appendRows = function (tableName, rows) {
          if (!rows || !rows.length) return existing;
          const header = "## " + tableName;
          const hIdx = existing.indexOf(header);
          if (hIdx < 0) return existing; // 表头缺失不动台账（防误清空）
          const insertAt = tableInsertAt(existing, hIdx);
          if (insertAt < 0) return existing;
          const block = rows.map(function (r) {
            if (tableName === "母题密度") return "| " + r.subject + " | " + (r.count || 1) + " | " + (args.chapterId || targets.map(function (c) { return c.id; }).join("+")) + " |";
            return "| " + r.subject + " | " + (r.detail || "—") + " | " + (args.chapterId || targets.map(function (c) { return c.id; }).join("+")) + " |";
          }).join("\n");
          return existing.slice(0, insertAt) + block + "\n" + existing.slice(insertAt);
        };
        existing = appendRows("数字锚", obj.numbers);
        existing = appendRows("信息来源", obj.sources);
        existing = appendRows("时间锚", obj.times);
        existing = appendRows("母题密度", obj.motifs);
        // 追读力表：按章节行追加/替换（该章已有行则覆盖，避免重复）
        const appendPulls = function (rows) {
          if (!rows || !rows.length) return existing;
          const header = "## 追读力";
          const hIdx = existing.indexOf(header);
          if (hIdx < 0) return existing;
          const insertAt = tableInsertAt(existing, hIdx);
          if (insertAt < 0) return existing;
          let out = existing;
          for (const r of rows) {
            const ch = String(r.chapter || args.chapterId || "");
            const rowText = "| " + ch + " | " + (r.hook || "—") + " | " + (r.cool || "—") + " | " + (r.payoff || "—") + " | " + (r.debt || "—") + " |";
            if (ch) {
              const esc = ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const rowRe = new RegExp("^\\| " + esc + " \\|.*$", "m");
              if (rowRe.test(out)) { out = out.replace(rowRe, rowText); continue; }
            }
            out = out.slice(0, insertAt) + rowText + "\n" + out.slice(insertAt);
          }
          return out;
        };
        existing = appendPulls(obj.pulls);
        await engine.writeText(ledgerRel, existing);
        return "扫描完成：" + targets.map(function (c) { return c.id; }).join("+") + "。新增 数字锚 " + (obj.numbers || []).length + " / 来源 " + (obj.sources || []).length + " / 时间锚 " + (obj.times || []).length + " / 母题 " + (obj.motifs || []).length + " / 追读力 " + (obj.pulls || []).length + " 条。台账：lore/other/ledger.md";
      }
      return "未知 action：" + args.action;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_audit",
    description: "章后八项体检：感知汇聚（体感流）/多角色体感校验/断层检测/情感弧线/读者视角穿行/叙述主体与语感/节奏信号（跨章钩子·爽点密度·断档·欠账）/AI 味检查（Anti-AI 八条）。输出检查清单并保存 research/audit-*.md。",
    parameters: {
      chapterId: { type: "string", description: "要检查的章节 id（缺省最近一章）" },
      recent: { type: "integer", description: "检查最近 N 章，默认 1" },
      save: { type: "boolean", description: "是否保存报告到 research/，默认 true" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      let targets = [];
      if (args.chapterId) { const c = chapters.find(function (x) { return x.id === args.chapterId; }); if (!c) return "章节不存在：" + args.chapterId; targets = [c]; }
      else targets = chapters.slice(-Math.max(1, args.recent || 1));
      if (!targets.length) return "（无章节可查）";
      const texts = [];
      for (const c of targets) { let t = ""; try { t = await engine.readText(c.path); } catch (e) {} texts.push("【" + c.id + " " + (c.title || "") + "】\n" + t); }
      let context = "";
      try {
        const cards = (await engine.listFiles("lore")).filter(function (f) { return f.indexOf("other/") !== 0 && f.indexOf("README") < 0; }).slice(0, 12);
        for (const f of cards) { try { context += "--- " + f + " ---\n" + (await engine.readText("lore/" + f)).slice(0, 400) + "\n"; } catch (e) {} }
      } catch (e) {}
      let ledger = ""; try { ledger = await engine.readText("lore/other/ledger.md"); } catch (e) {}
      const report = await engine.generate({
        maxTokens: 20000,
        system: "你是主笔审稿人。以作家身份对给定章节做六项体检，输出 Markdown 检查清单：每条含【检查项】【发现】（引用原文为证，不许空泛）【严重度：高/中/低】【修法建议】。只出清单，不改正文。",
        prompt: "【八项体检】\n1. 感知汇聚：主角身体状态（触觉/味觉/心跳/呼吸/温度/手）是否有连续变化线？情绪转折有无身体落点？\n2. 多角色体感校验：每个在场角色是否'活'着——有身体反应、有自己想要的、台词不像传话筒？\n3. 断层检测：数字口径/时间/信息来源/伏笔状态与台账或前文是否冲突？（对照【正典台账】）\n4. 情感弧线：本章情绪有无'起点→扰动→变化→落点'？是否事件空转、情感无变化？\n5. 读者视角穿行：首读读者此刻会问什么/算什么？有无钩子？信息是否读者先于角色知道（剧透感）？\n6. 叙述主体与语感：叙述主体是否混乱？视角是否跳（如预叙/作者声音冒头）？语感是否漂移（13 岁主角 vs 作者腔）？\n7. 节奏信号（跨章，对照【正典台账】追读力表）：近 5 章钩子类型是否连续同构（连续 2 章同类型=警告并建议差异化）；本章爽点/微兑现密度（约多少字一次，过疏=提醒）；人物线断档（主要配角超 10 章未出场或未提及=提醒）；上章欠账是否被回应（未回应=阻断级提醒）。\n8. AI 味检查（对照 Anti-AI 清单，逐条给结论）：①副词堆砌（缓缓/淡淡/微微/轻轻）②段末感悟句/完整闭环③情绪贴标签（'他感到X'）④全员同反应（瞳孔微缩/心中一凛）⑤对话完美应答无潜台词无打断⑥节奏均匀无疏密对比⑦章末安全着陆（冲突全解决）⑧展示后解释（动作后补解释句）。每条：违规=举原文例；零违规=pass。\n\n【章节正文】\n" + texts.join("\n\n") + "\n\n【设定摘要】\n" + context.slice(0, 6000) + "\n\n【正典台账】\n" + ledger.slice(0, 2000),
        signal: exec && exec.signal
      });
      const label = targets.map(function (c) { return c.id; }).join("+");
      if (!String(report || "").trim()) return "章后体检生成失败：模型返回空（可重试；若持续为空请检查 maxTokens 与模型通道）。";
      if (args.save !== false) {
        const rel = "research/audit-" + label + ".md";
        try { await engine.writeText(rel, "# 章后体检 " + label + "\n\n" + report); return "章后体检完成，已保存 research/audit-" + label + ".md：\n\n" + report; } catch (e) { return "章后体检完成（保存失败：" + (e.message || e) + "）：\n\n" + report; }
      }
      return report;
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
        keyRole: "sync",
        effort: "high",
        maxTokens: 20000,
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

  // ── 命名与修改：章节/卷重命名（匹配性命名）──
  ctx.tools.register(defineTool({
    name: "novel_rename",
    description: "重命名章节标题或分卷名：章节改名会同步更新台账与正文标题行（可选）；分卷改名会同步移动 chapters/ 下的全部章节文件。修改正文内容请用 novel_polish。",
    parameters: {
      action: { type: "string", required: true, enum: ["chapter", "volume"], description: "chapter 改章节标题 / volume 改分卷名" },
      chapterId: { type: "string", description: "章节 id（action=chapter 时必填）" },
      title: { type: "string", description: "新章节标题（action=chapter 时必填）" },
      volume: { type: "string", description: "旧分卷名（action=volume 时必填）" },
      newVolume: { type: "string", description: "新分卷名（action=volume 时必填）" },
      renameBody: { type: "boolean", description: "chapter 时是否同步替换正文里的标题行，默认 true" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.action === "chapter") {
        const cid = String(args.chapterId || "").trim();
        const nt = String(args.title || "").trim();
        if (!cid || !nt) return "需要 chapterId 与 title";
        const r = await engine.renameChapter(cid, nt, args.renameBody);
        return r && r.ok ? "章节已改名：" + cid + " → 《" + nt + "》" : ((r && r.error) || "改名失败");
      }
      if (args.action === "volume") {
        const ov = String(args.volume || "").trim();
        const nv = String(args.newVolume || "").trim();
        if (!ov || !nv) return "需要 volume 与 newVolume";
        const r = await engine.renameVolume(ov, nv);
        return r && r.ok ? "分卷已改名：「" + ov + "」→「" + nv + "」，迁移 " + r.moved + " 个章节文件。" : ((r && r.error) || "改名失败");
      }
      return "未知 action";
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_sync",
    description: "章末自动编排：写完章节后一键执行全套记忆维护（情节摘要 → 设定抽取 → 人物/世界状态回写 → 演化检测 → 未回收伏笔提醒 → 活目录刷新）。可用 skip 跳过某步骤。",
    parameters: {
      chapterId: { type: "string", description: "刚写完的章节 id；缺省处理最近 N 章" },
      recent: { type: "integer", description: "处理最近 N 章，默认 3" },
      skip: { type: "string", description: "跳过的步骤（逗号分隔：summarize/extract/state/evolution/foreshadow/catalog）" }
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
      const r = await runSync(engine, { chapterId: args.chapterId, recent: args.recent, skip: skip, signal: exec && exec.signal });
      const lines = r.results.map(function (res) {
        if (res.status === "error") return "- ⚠ " + res.step + "失败：" + res.message;
        let line = "- ✅ " + res.step;
        if (res.step === "state") line = "- ✅ state（人物 " + res.characters + " 项回写 / 世界状态 " + res.world + " 项）";
        if (res.count !== undefined) line += " " + res.count + " 条";
        if (res.unresolved !== undefined) line = res.unresolved.length ? "- ⚠ 未回收伏笔 " + res.unresolved.length + " 条：" + res.unresolved.join("、") : "- ✅ 伏笔全部回收";
        if (res.archived) line += "（日志已归档）";
        return line;
      });
      if (!skip.includes("catalog")) {
        try {
          const cat = await engine.rebuildCatalog();
          lines.push("- ✅ 活目录已刷新（chapters/INDEX.md：" + cat.chapters + " 章 / " + cat.volumes + " 卷）");
        } catch (e) { lines.push("- ⚠ 目录刷新失败：" + e.message); }
      }
      if (!skip.includes("audit")) {
        lines.push("\n💡 章后体检：运行 novel_audit" + (args.chapterId ? " chapterId=" + args.chapterId : "") + " 做六项检查（感知汇聚/多角色体感/断层/情感弧线/读者穿行/叙述主体语感），发现以原文为证+修法建议。");
      }
      return "章末编排（" + r.label + "）：\n" + lines.join("\n");
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
          ? (function () {
              const c = stats.conceptStats || stats;
              const embedErr = stats.lastError ? "（嵌入 API 错误：" + String(stats.lastError).slice(0, 160) + "，已自动降级概念索引）" : "";
              return "概念索引（DeepSeek）新嵌 " + c.embedded + " 篇 / 词表 " + (c.vocab !== undefined ? c.vocab + " 词" : "已建") + (c.failed ? "，失败 " + c.failed : "") + (c.skipped ? "，跳过 " + c.skipped : "") + embedErr;
            })()
          : (stats.reason ? stats.reason : ("新嵌 " + stats.embedded + " 篇 / " + stats.chunks + " 块" + (stats.failed ? "，失败 " + stats.failed : "") + (stats.remaining ? "，剩余 " + stats.remaining : "，已全部嵌入") + (stats.lastError ? "；错误：" + String(stats.lastError).slice(0, 300) : "")));
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
    name: "novel_market",
    description: "平台审稿（起点+番茄）：按平台视角体检章节——起点（黄金三章/单章字数/每3章爽点释放/长线伏笔/章末钩子/均订逻辑）、番茄（第1000字小爽点/前3章打脸反转/完读率/憋屈时长/爽点密度），输出各平台适配度与改造建议。",
    parameters: {
      platform: { type: "string", enum: ["both", "qidian", "fanqie"], description: "审稿平台：both 双平台 / qidian 起点 / fanqie 番茄，默认 both" },
      chapterId: { type: "string", description: "要审的章节 id（缺省最近 N 章）" },
      recent: { type: "integer", description: "审最近 N 章，默认 3" },
      save: { type: "boolean", description: "保存报告到 research/，默认 true" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      let targets = [];
      if (args.chapterId) { const c = chapters.find(function (x) { return x.id === args.chapterId; }); if (!c) return "章节不存在：" + args.chapterId; targets = [c]; }
      else targets = chapters.slice(-Math.max(1, args.recent || 3));
      if (!targets.length) return "（无章节可审）";
      const platform = args.platform || "both";
      const texts = [];
      for (const c of targets) { let t = ""; try { t = await engine.readText(c.path); } catch (e) {} texts.push("【" + c.id + " " + (c.title || "") + "】\n" + t.slice(0, 6000)); }
      const qidian = platform === "both" || platform === "qidian";
      const fanqie = platform === "both" || platform === "fanqie";
      const report = await engine.generate({
        keyRole: "sync",
        maxTokens: 20000,
        system: "你是网文平台审稿人。以编辑视角按平台规则体检章节，输出 Markdown 报告：每条含【检查项】【发现】（引用原文为证，不许空泛）【严重度：高/中/低】【改造建议】。只出报告，不改正文。",
        prompt: "【平台规则】\n起点：单章 2000-3000 字；黄金三章定生死（开局钩子/金手指最晚第 3 章上线/前 3 章一次明确爽点释放）；每 3 章一次爽点释放；读者吃质量（逻辑/长线伏笔/人物弧光）；章末钩子强度=均订节点。\n番茄：单章 2000-2200 字；第 1000 字就要第一次小爽点（被羞辱→亮底牌类）；前 3 章必须打脸+身份反转；全程高频爽点、不能长时间憋屈（超 2-3 章读者就走）；短句多少心理描写；每章结尾强钩=完读率。\n\n【正文】\n" + texts.join("\n\n") + (qidian ? "\n\n输出【起点视角】：1.黄金三章检查（若含前三章：开局钩子/金手指上线章/前三章爽点释放）；2.单章字数是否达标；3.每 3 章爽点释放节奏；4.长线伏笔与世界观厚度（有没有值得追下去的线）；5.章末钩子强度（读者下章订阅的理由）。" : "") + (fanqie ? "\n\n输出【番茄视角】：1.第 1000 字小爽点检查（没有=高优）；2.前 3 章打脸/反转检查；3.憋屈时长（连续憋屈超过 2-3 章=高优）；4.爽点/微兑现密度（每章至少 2 处、约每 600-900 字一次）；5.章末钩子强度（完读率）。" : "") + "\n\n最后输出【双平台结论】：此书当前调性偏向哪个平台；另一平台需哪些改造（砍什么/加什么，列具体可执行项）；哪些优势两平台都成立（保留）。",
        signal: exec && exec.signal
      });
      const label = targets.map(function (c) { return c.id; }).join("+");
      if (args.save !== false) {
        const rel = "research/market-" + label + "-" + platform + ".md";
        try { await engine.writeText(rel, "# 平台审稿 " + label + "（" + platform + "）\n\n" + report); return "平台审稿完成，已保存 research/market-" + label + "-" + platform + ".md：\n\n" + report; } catch (e) { return "平台审稿完成（保存失败：" + (e.message || e) + "）：\n\n" + report; }
      }
      return report;
    }
  }));

  ctx.tools.register(defineTool({
    name: "novel_censor",
    description: "发书前敏感/违禁自查：按六大类+红线（涉政/色情擦边/暴力血腥/赌博毒品/封建迷信/现实机构影射/未成年红线）检查章节正文，输出风险清单与改写建议（启发式安全网，最终以平台审核为准）。",
    parameters: {
      chapterId: { type: "string", description: "要检查的章节 id（缺省最近 N 章）" },
      recent: { type: "integer", description: "检查最近 N 章，默认 3" },
      save: { type: "boolean", description: "保存报告到 research/，默认 true" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      let manifest = {};
      try { manifest = await engine.readManifest(); } catch (e) { return "（尚未初始化项目）"; }
      const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      let targets = [];
      if (args.chapterId) { const c = chapters.find(function (x) { return x.id === args.chapterId; }); if (!c) return "章节不存在：" + args.chapterId; targets = [c]; }
      else targets = chapters.slice(-Math.max(1, args.recent || 3));
      if (!targets.length) return "（无章节可查）";
      const texts = [];
      for (const c of targets) { let t = ""; try { t = await engine.readText(c.path); } catch (e) {} texts.push("【" + c.id + " " + (c.title || "") + "】\n" + t.slice(0, 6000)); }
      const report = await engine.generate({
        keyRole: "sync",
        maxTokens: 20000,
        system: "你是网文平台审核自查员。按敏感/违禁大类检查正文，输出 Markdown 报告：每条含【类别】【风险点】（引用原文为证）【严重度：高/中/低】【改写建议】。只报风险不报安全段，全过则明确说'全部通过'。",
        prompt: "【自查六大类+红线】\n1.涉政/时政：真实政治人物/政权/敏感历史事件/现实政治影射→必须架空。\n2.色情低俗/擦边：露骨性描写、器官直写、未成年性相关（红线）。\n3.暴力血腥/自杀自残：过度血腥细节、自杀自残具体方法、虐待细节。\n4.赌博/毒品/违禁品：赌术、制毒吸毒、违禁药物的具体操作/配方/剂量。\n5.封建迷信：引导读者现实中算命/求神治病=踩雷（架空世界的法术设定没问题）。\n6.现实机构影射：警察/政府/宗教等现实机构负面描写、真实地名黑化。\n自查句式：这段能被提取当教程吗→删细节；能对应现实事件吗→架空化；对未成年可读吗→转场。\n\n【正文】\n" + texts.join("\n\n"),
        signal: exec && exec.signal
      });
      const label = targets.map(function (c) { return c.id; }).join("+");
      if (args.save !== false) {
        const rel = "research/censor-" + label + ".md";
        try { await engine.writeText(rel, "# 敏感自查 " + label + "\n\n" + report); return "敏感自查完成，已保存 research/censor-" + label + ".md：\n\n" + report; } catch (e) { return "敏感自查完成（保存失败：" + (e.message || e) + "）：\n\n" + report; }
      }
      return report;
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
        keyRole: "polish",
        maxTokens: 20000,
        system: "你是严格的中文校对编辑。只找机械性硬伤（错别字、标点误用、的地得混用、重复用词、数字格式、引号配对），输出修改清单；绝不改写文风、不润色、不重写句子。",
        prompt: "【检查重点】" + focus + "\n\n【正文】\n" + text + "\n\n请逐条列出发现的问题，格式：片段 | 问题类型 | 建议改为。没有发现就写「未发现硬伤」。不要输出原文全文。",
        signal: exec && exec.signal
      });
      return "校对报告（" + rel + "）：\n" + report;
    }
  }));

  // ── 人物动态状态层：他此刻要什么、怕什么、刚失去什么（推演人物选择的依据）──
  ctx.tools.register(defineTool({
    name: "novel_char_state",
    description: "查看/更新主要人物的动态状态（此刻想要什么、害怕什么、刚失去什么、人际变化）。这些状态会注入后续章节生成，让模型以人物视角推演选择，而不是按指令执行。每章写完建议随手更新。",
    parameters: {
      action: { type: "string", required: true, enum: ["view", "set"], description: "view 查看全部 / set 更新某人物" },
      name: { type: "string", description: "人物名（set 必填；缺省新建）" },
      want: { type: "string", description: "此刻想要什么（一句话）" },
      fear: { type: "string", description: "此刻害怕什么（一句话）" },
      lost: { type: "string", description: "刚失去了什么（一句话）" },
      relation: { type: "string", description: "与主要人物的关系现状（一句话）" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const data = await loadCharacters(engine);
      if (args.action === "view") {
        if (!data.characters.length) return "（人物状态为空。用 novel_char_state set 登记：如 陈沧 想要=查清江城空无的真相 害怕=空白年被揭开）";
        return "人物此刻的状态：\n" + data.characters.map(function (c) {
          const bits = [];
          if (c.want) bits.push("想要：" + c.want);
          if (c.fear) bits.push("害怕：" + c.fear);
          if (c.lost) bits.push("刚失去：" + c.lost);
          if (c.relation) bits.push("人际：" + c.relation);
          return "- " + c.name + "：" + (bits.length ? bits.join("；") : "（无状态）");
        }).join("\n");
      }
      if (args.action === "set") {
        const nm = String(args.name || "").trim();
        if (!nm) return "需要 name（人物名）";
        let c = data.characters.find(function (x) { return x.name === nm; });
        if (!c) { c = { name: nm }; data.characters.push(c); }
        if (args.want !== undefined) c.want = String(args.want);
        if (args.fear !== undefined) c.fear = String(args.fear);
        if (args.lost !== undefined) c.lost = String(args.lost);
        if (args.relation !== undefined) c.relation = String(args.relation);
        await saveCharacters(engine, data);
        return "已更新「" + nm + "」的动态状态。后续生成将以此推演人物选择。";
      }
      return "未知 action";
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
  }))

  // ── 写作交互模式：每章走向抉择（文件协议 + 面板小窗）──
  ctx.tools.register(defineTool({
    name: "novel_choice",
    description: "写作交互：基于当前局势推演 3-5 个故事走向（含利弊），推送到写作面板「抉择」小窗等待作者选择或扩写。之后用 novel_wait_choice 获取作者的答案，作为下一章生成的指令。",
    parameters: {
      fork: { type: "string", required: true, description: "当前局势描述（如：陈沧发现钥匙能打开第二扇门，明天是否深入）" },
      context: { type: "string", description: "相关上下文补充（人物目标/未回收伏笔/最近发展）" },
      count: { type: "integer", description: "走向数量 2-5，默认 3" }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const fork = String(args.fork || "").trim();
      if (!fork) return "缺少 fork（当前局势）";
      const count = Math.min(5, Math.max(2, args.count || 3));
      const opts = await generateOptions(engine, fork, args.context || "", count);
      if (!opts.length) return "走向推演失败（模型未返回有效选项），请重试。";
      const lines = ["已推演 " + opts.length + " 个故事走向：", ""];
      for (const o of opts) {
        lines.push("[" + o.id + "] " + o.title + "：" + o.outline);
        if (o.pros.length) lines.push("  利：" + o.pros.join("；"));
        if (o.cons.length) lines.push("  弊：" + o.cons.join("；"));
      }
      lines.push("");
      lines.push("请用 harness 的 ask_user_question 向作者呈现以上选项（作者可选择或自由扩写），把作者的回答作为下一章生成指令。");
      return lines.join("\n");
    }
  }));

;
;

}