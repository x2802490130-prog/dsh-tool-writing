/**
 * 设定卡读写（独立模块，tools.js 与 sync.js 共用，避免循环依赖）。
 * 卡片 = front-matter（subject/category/updatedAt/chapterRef/summary/...）+ 正文。
 * summary：一句话卡摘要（≤40字），注入生成上下文时优先用它，替代"截头部 N 字"——
 * 防止关键设定不在卡片头部而被截断丢失（0.5.0 修复）。
 */

export function splitFrontMatter(text) {
  const s = String(text || "");
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: null, body: s };
  return { fm: m[1], body: s.slice(m[0].length) };
}

export function renderCard(subject, category, body, chapterRef, extra) {
  extra = extra || {};
  const meta = ["subject: " + subject, "category: " + category, "updatedAt: " + new Date().toISOString()];
  if (chapterRef) meta.push("chapterRef: " + chapterRef);
  if (extra.summary) meta.push("summary: " + String(extra.summary).replace(/\r?\n/g, " "));
  if (extra.source) meta.push("source: " + String(extra.source).replace(/\r?\n/g, " "));
  if (extra.confidence) meta.push("confidence: " + extra.confidence);
  return "---\n" + meta.join("\n") + "\n---\n\n" + String(body || "").trim() + "\n";
}

/** 读卡片时取"注入摘要"：有 front-matter summary 用它，否则截正文头部 */
export function cardInjectText(content, headCap) {
  const { fm, body } = splitFrontMatter(content);
  if (fm) {
    const m = fm.match(/^summary:\s*(.+)$/m);
    if (m) return m[1].trim();
  }
  return body.slice(0, headCap || 400);
}

// 写设定卡：保留历史正文、刷新元数据；卡片即档案
export async function writeLoreCard(engine, cat, name, summary, opts) {
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
export async function appendEvolutionToCard(engine, item) {
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

function safeName(s) {
  return String(s || "").trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 40) || "未分卷";
}
