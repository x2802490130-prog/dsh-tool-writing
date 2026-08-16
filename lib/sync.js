import { loadCharacters, saveCharacters, mergeRelations } from "./characters.js";
import { loadWorldState, saveWorldState, mergeWorldState } from "./worldstate.js";
import { writeLoreCard } from "./card.js";

function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function safeName(s) { return String(s || "").trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 40) || "未分卷"; }
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

/**
 * 章末记忆编排（可被 novel_sync 工具与 continue/draft 自动维护共用）：
 * summarize 情节摘要 → extract 设定抽取 → state 人物/世界状态回写 → evolution 演化检测 → foreshadow 伏笔提醒。
 * skip 数组可跳过：summarize / extract / state / evolution / foreshadow
 */
export async function runSync(engine, opts) {
  opts = opts || {};
  let manifest = {};
  try { manifest = await engine.readManifest(); } catch (e) { throw new Error("（尚未初始化项目，请先 novel_init）"); }
  const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
  let targets = [];
  if (opts.chapterId) {
    const c = chapters.find(function (x) { return x.id === opts.chapterId; });
    if (!c) throw new Error("章节不存在：" + opts.chapterId);
    targets = [c];
  } else {
    targets = chapters.slice(-Math.max(1, opts.recent || 3));
  }
  if (!targets.length) return { label: "", results: [] };
  const skip = opts.skip || [];
  const results = [];
  const excerpts = [];
  for (const c of targets) {
    let text;
    try { text = await engine.readText(c.path); } catch (e) { text = ""; }
    excerpts.push("【" + c.id + " " + (c.title || "") + "】\n" + text.slice(0, 6000));
  }
  const joined = excerpts.join("\n\n");
  const label = targets.map(function (c) { return c.id; }).join(",");
  if (skip.indexOf("summarize") < 0) {
    try {
      const summary = await engine.generate({
        system: "你是资深网文编辑，擅长提炼情节摘要。",
        prompt: "请为以下章节写一段 150~300 字情节摘要（核心事件、人物关键动作、埋下的伏笔）：\n\n" + joined,
        signal: opts.signal
      });
      const rel = "lore/other/plot-log.md";
      let log = "";
      try { log = await engine.readText(rel); } catch (e) { log = ""; }
      await engine.writeText(rel, (log + "\n\n## " + stamp() + " · " + label + "\n" + summary).trim());
      // 台账同步最近摘要
      try {
        const last = targets[targets.length - 1];
        const ch = chapters.find(function (x) { return x.id === last.id; });
        if (ch) { ch.summary = String(summary).replace(/\r?\n/g, " ").slice(0, 120); await engine.writeManifest(manifest); }
      } catch (e) {}
      // 防膨胀：超过 6 万字归档，只留尾部 2.5 万字
      if (log.length > 60000) {
        const cut = log.length - 25000;
        const archiveRel = "lore/other/plot-log-archive-" + stamp() + ".md";
        await engine.writeText(archiveRel, log.slice(0, cut));
        await engine.writeText(rel, log.slice(cut));
        results.push({ step: "summarize", status: "ok", archived: archiveRel });
      } else {
        results.push({ step: "summarize", status: "ok" });
      }
    } catch (e) { results.push({ step: "summarize", status: "error", message: e.message }); }
  }
  if (skip.indexOf("extract") < 0) {
    try {
      const extracted = await engine.generate({
        system: "你是网文设定整理师。只从给定正文抽取，不编造。",
        prompt: "【正文】\n" + joined + "\n\n请输出 JSON：{\"items\":[{\"name\":\"条目名\",\"summary\":\"一句话卡摘要（≤40字，提炼本条最关键设定，供生成时注入）\",\"detail\":\"详细描述（本条在本章出现的事实）\",\"category\":\"characters 或 world\"}]}。",
        json: true,
        signal: opts.signal
      });
      const items = parseItems(extracted);
      let n = 0;
      for (const it of items) {
        const cat = (it.category === "world") ? "world" : "characters";
        await writeLoreCard(engine, cat, it.name || "条目", it.detail || it.summary || "", { chapterRef: label, extra: { summary: it.summary || "" } });
        n++;
      }
      results.push({ step: "extract", status: "ok", count: n });
    } catch (e) { results.push({ step: "extract", status: "error", message: e.message }); }
  }
  // state：人物动态状态（characters.json）+ 世界状态锚点（world-state.json）回写
  // 这是"每章迭代记忆"的自动通道：不再依赖主 agent 记得更新人物卡。
  if (skip.indexOf("state") < 0) {
    try {
      let wsExisting = {};
      try { wsExisting = await loadWorldState(engine); } catch (e) { wsExisting = {}; }
      const knownObjects = (wsExisting.objects || []).map(function (x) { return x.name; });
      const raw = await engine.generate({
        system: "你是设定状态追踪师。从正文抽取本场戏结束时的人物动态状态与世界状态锚点，只抽取、不编造。",
        prompt: "【正文】\n" + joined + "\n\n【已有物证名（若正文涉及其中某件，务必复用该名字，只更新其位置与揭示层；确实是新物证才起新名）】\n" + (knownObjects.length ? knownObjects.join("、") : "（无）") + "\n\n请输出 JSON：{\"characters\":[{\"name\":\"姓名\",\"want\":\"此刻想要\",\"fear\":\"此刻害怕\",\"lost\":\"刚失去\",\"relation\":\"人际变化\"}（只输出本章出场且状态较之前有变化的人物；四项完整给出，没有的项给空串）],\"places\":[{\"name\":\"地点名\",\"note\":\"状态备注\"}],\"people\":[{\"name\":\"人名\",\"role\":\"身份\",\"aliases\":[\"别名\"],\"note\":\"备注\"}],\"objects\":[{\"name\":\"物证名\",\"location\":\"当前在何处/何人手中\",\"source\":\"来自哪里\",\"layer\":2,\"layerNote\":\"本章揭示到的新一层信息\"}],\"relations\":[{\"a\":\"人物A\",\"b\":\"人物B\",\"from\":\"此前关系\",\"to\":\"本章后的关系\",\"note\":\"备注\"}],\"terms\":[{\"canonical\":\"规范称谓\",\"aliases\":[\"不规范的变体\"],\"note\":\"说明\"}]}。未涉及的字段输出空数组；拿不准的字段留空字符串。",
        json: true,
        signal: opts.signal
      });
      const s = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      let patch = {};
      try { patch = JSON.parse(s); } catch (e) { patch = {}; }
      let charN = 0;
      if (Array.isArray(patch.characters) && patch.characters.length) {
        const data = await loadCharacters(engine);
        const list = Array.isArray(data.characters) ? data.characters : [];
        for (const it of patch.characters) {
          const name = String(it.name || "").trim();
          if (!name) continue;
          // 整体覆盖：出场人物的状态以本章结束为准（空串=该项已不存在，清空旧值）
          const base = { name: name, want: "", fear: "", lost: "", relation: "" };
          for (const k of ["want", "fear", "lost", "relation"]) {
            if (it[k] !== undefined && it[k] !== null) base[k] = String(it[k]).trim();
          }
          // quirk/voice 为累积素材，非空才覆盖
          for (const k of ["quirk", "voice"]) {
            if (it[k] !== undefined && it[k] !== null && String(it[k]).trim() !== "") base[k] = String(it[k]).trim();
          }
          const idx = list.findIndex(function (x) { return x.name === name; });
          if (idx >= 0) { const old = list[idx]; for (const k of ["quirk","voice"]) if (old[k] && !base[k]) base[k] = old[k]; list[idx] = base; }
          else list.push(base);
          charN++;
        }
        const rels = mergeRelations(data.relations, patch.relations);
        await saveCharacters(engine, { characters: list, relations: rels });
      }
      let wsN = 0;
      const wsPatch = { terms: patch.terms, places: patch.places, people: patch.people, objects: patch.objects };
      if ((wsPatch.terms || []).length || (wsPatch.places || []).length || (wsPatch.people || []).length || (wsPatch.objects || []).length) {
        const ws = await loadWorldState(engine);
        const merged = mergeWorldState(ws, wsPatch);
        wsN = (merged.terms || []).length + (merged.places || []).length + (merged.people || []).length + (merged.objects || []).length;
        await saveWorldState(engine, merged);
      }
      results.push({ step: "state", status: "ok", characters: charN, world: wsN });
    } catch (e) { results.push({ step: "state", status: "error", message: e.message }); }
  }
  if (skip.indexOf("evolution") < 0) {
    try {
      const loreTexts = [];
      for (const lf of (await engine.listFiles("lore")).slice(0, 30)) {
        try { loreTexts.push("--- " + lf + " ---\n" + await engine.readText("lore/" + lf)); } catch (e) {}
      }
      const result = await engine.generate({
        system: "你是设定演化追踪师。对比人物卡/设定与最新正文，检测细节演变（性格/能力/关系/动机/心理/世界观）。",
        prompt: "【现有设定】\n" + loreTexts.join("\n\n").slice(0, 5000) + "\n\n【最近正文】\n" + joined + "\n\n输出 JSON：{\"items\":[{\"subject\":\"对象\",\"dimension\":\"性格/能力/...\",\"from\":\"前\",\"to\":\"后\",\"reason\":\"诱因\",\"chapterId\":\"章节\"}]}；无演化输出 {\"items\":[]}。",
        json: true,
        signal: opts.signal
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
      results.push({ step: "evolution", status: "ok", count: n });
    } catch (e) { results.push({ step: "evolution", status: "error", message: e.message }); }
  }
  if (skip.indexOf("foreshadow") < 0) {
    try {
      const fore = JSON.parse(await engine.readText("foreshadowing.json"));
      const un = (fore.entries || []).filter(function (x) { return !x.resolvedIn; });
      results.push({ step: "foreshadow", status: "ok", unresolved: un.map(function (x) { return x.name; }) });
    } catch (e) {}
  }
  return { label: label, results: results };
}
