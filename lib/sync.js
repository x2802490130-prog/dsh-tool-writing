function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function safeName(s) { return String(s || "").trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 40) || "未分卷"; }
function parseItems(text) {
  const s = String(text || "").trim();
  let t = s.replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\`\`\`\s*$/, "").trim();
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
      results.push({ step: "summarize", status: "ok" });
    } catch (e) { results.push({ step: "summarize", status: "error", message: e.message }); }
  }
  if (skip.indexOf("extract") < 0) {
    try {
      const extracted = await engine.generate({
        system: "你是网文设定整理师。只从给定正文抽取，不编造。",
        prompt: "【正文】\n" + joined + "\n\n请输出 JSON：{\"items\":[{\"name\":\"条目名\",\"summary\":\"描述\",\"category\":\"characters 或 world\"}]}。",
        json: true,
        signal: opts.signal
      });
      const items = parseItems(extracted);
      let n = 0;
      for (const it of items) {
        const cat = (it.category === "world") ? "world" : "characters";
        const name = safeName(it.name || "条目");
        const rel = "lore/" + cat + "/" + name + ".md";
        let existing = "";
        try { existing = await engine.readText(rel); } catch (e) { existing = ""; }
        await engine.writeText(rel, ((existing ? existing + "\n\n" : "") + (it.summary || "")).trim());
        n++;
      }
      results.push({ step: "extract", status: "ok", count: n });
    } catch (e) { results.push({ step: "extract", status: "error", message: e.message }); }
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
