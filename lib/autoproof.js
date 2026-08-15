/**
 * 生成后自动机械校对（二次结合的第 1 层）：
 * - 用一次 LLM 调用检查新章正文的机械硬伤（错字/缺字/人名/称谓/标点/的地得）。
 * - fixes 只对"唯一匹配"做字级替换（出现次数≠1 或改动幅度过大的一律跳过，防误伤）。
 * - 可议项（疑似重复意象/低效比喻/逻辑疑虑）只写报告，绝不代改——
 *   象征性重复由作者判断，机器只提醒"低效重复"。
 */
import { countWords } from "./engine.js";

function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

/** 纯函数：应用修复清单。返回 {text, applied, skipped}。便于单测。 */
export function applyProofFixes(text, fixes) {
  let out = String(text || "");
  const applied = [];
  const skipped = [];
  for (const f of (Array.isArray(fixes) ? fixes : [])) {
    const find = String((f && f.find) || "");
    const replace = String((f && f.replace) || "");
    if (find.trim().length < 2) { if (find) skipped.push(f); continue; }
    if (replace === "" || replace === find) { skipped.push(f); continue; }
    // 改动幅度约束：替换不能是原文的成倍扩张（防模型借校对重写句子）
    if (replace.length > find.length * 2 + 2) { skipped.push(f); continue; }
    const count = out.split(find).length - 1;
    if (count !== 1) { skipped.push(f); continue; }
    out = out.split(find).join(replace);
    applied.push(f);
  }
  return { text: out, applied: applied, skipped: skipped };
}

/**
 * 校对一章正文。opts: { chapterId, text, names }
 * 返回 { fixed, fixCount, skipped, notes, noteRel }
 */
export async function autoProof(engine, opts) {
  opts = opts || {};
  const text = String(opts.text || "");
  const names = Array.isArray(opts.names) && opts.names.length ? opts.names : [];
  let result = { fixes: [], notes: [] };
  try {
    const raw = await engine.generate({
      system: "你是严格的中文校对编辑。只找机械性硬伤，绝不改写文风、不润色、不重写句子。",
      prompt:
        "检查下面章节正文的机械硬伤：①错别字/形近字（尤其人名写错）②缺字/衍字 ③标点配对与误用 ④的地得混用 ⑤称谓不一致（对照人物名单）⑥引号配对。\n" +
        "只把「确定无疑」的硬伤放进 fixes（find=原文片段，replace=修正后片段，find 必须与正文逐字一致）；" +
        "可议项——疑似低效重复的意象/比喻、逻辑疑虑——放进 notes（text=说明，type=imagery 或 logic 或 wording），不要放进 fixes。\n" +
        "输出 JSON：{\"fixes\":[{\"find\":\"…\",\"replace\":\"…\",\"reason\":\"…\"}],\"notes\":[{\"text\":\"…\",\"type\":\"imagery|logic|wording\"}]}；无问题输出空数组。\n\n" +
        (names.length ? "【人物名单（对照检查人名错字）】\n" + names.join("、") + "\n\n" : "") +
        "【正文】\n" + text,
      json: true,
      signal: opts.signal
    });
    const s = String(raw || "").replace(/^```(?:json)?s*/i, "").replace(/```s*$/, "").trim();
    try {
      const obj = JSON.parse(s);
      if (Array.isArray(obj.fixes)) result.fixes = obj.fixes;
      if (Array.isArray(obj.notes)) result.notes = obj.notes;
    } catch (e) {}
  } catch (e) {
    return { fixed: 0, fixCount: 0, skipped: 0, notes: [], noteRel: "", error: e.message };
  }
  const applied = applyProofFixes(text, result.fixes);
  let noteRel = "";
  const notes = result.notes;
  if (notes.length) {
    const rel = "review/ch-" + String(opts.chapterId || "unknown") + ".md";
    const body = "## 自动校对报告 · " + String(opts.chapterId || "") + " · " + stamp() + "\n\n" +
      notes.map(function (n, i) {
        return String(i + 1) + ". [" + (n.type || "wording") + "] " + String(n.text || "");
      }).join("\n") + "\n\n（本报告只记录可议项，不代改。是否修改由作者决定。）\n";
    try { await engine.writeText(rel, body); noteRel = rel; } catch (e) {}
  }
  return {
    fixed: applied.applied.length,
    skipped: applied.skipped.length,
    notes: notes.length,
    noteRel: noteRel,
    applied: applied.applied.map(function (f) { return f.find + "→" + f.replace; }),
    text: applied.text
  };
}
