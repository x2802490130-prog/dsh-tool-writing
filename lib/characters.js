/**
 * 人物动态状态层：设定卡是"他是谁"（静态），这里是"他此刻要什么、怕什么、刚失去什么"（动态），
 * 以及 0.6.0 新增的"剩余人格"（与主线无关的习惯/欲望/生活细节）与"关系网"（人物间怎么互相看待）。
 * 生成章节时注入，让人物选择可推导、出场人物有活着的影子——剩余人格是配角不沦为工具人的素材来源。
 */

const FILE = "characters.json";

export async function loadCharacters(engine) {
  try {
    const j = JSON.parse(await engine.readText(FILE));
    return j && j.characters ? j : { characters: [] };
  } catch (e) {
    return { characters: [] };
  }
}

export async function saveCharacters(engine, data) {
  await engine.writeText(FILE, JSON.stringify(data, null, 2));
}

/** 人物状态渲染为提示文本（注入生成上下文） */
export function charactersContext(data) {
  const list = (data && data.characters) || [];
  const parts = [];
  const charLines = ["【人物此刻的状态】"];
  for (const c of list) {
    const bits = [];
    if (c.want) bits.push("想要：" + c.want);
    if (c.fear) bits.push("害怕：" + c.fear);
    if (c.lost) bits.push("刚失去：" + c.lost);
    if (c.relation) bits.push("人际：" + c.relation);
    if (!bits.length) continue;
    charLines.push("- " + c.name + "：" + bits.join("；"));
    if (c.quirk) charLines.push("  剩余人格（与主线无关的生活细节，出场时可用）：" + c.quirk);
    if (c.voice) charLines.push("  说话方式：" + c.voice);
  }
  if (charLines.length > 1) parts.push(charLines.join("\n"));
  // 关系网
  const rels = Array.isArray(data.relations) ? data.relations : [];
  if (rels.length) {
    const rl = ["【人物关系网（互相怎么看）】"];
    for (const r of rels) {
      const seg = [];
      if (r.from) seg.push(r.from);
      if (r.to) seg.push("→ " + r.to);
      if (r.note) seg.push("（" + r.note + "）");
      rl.push("- " + r.a + " ⇄ " + r.b + "：" + (seg.join(" ") || "相关"));
    }
    parts.push(rl.join("\n"));
  }
  return parts.length ? parts.join("\n") + "\n" : "";
}

/** 按关系对 upsert */
export function mergeRelations(rels, patchItems) {
  const list = Array.isArray(rels) ? rels.slice() : [];
  for (const it of (Array.isArray(patchItems) ? patchItems : [])) {
    const a = String((it && it.a) || "").trim();
    const b = String((it && it.b) || "").trim();
    if (!a || !b) continue;
    const idx = list.findIndex(function (x) {
      return (x.a === a && x.b === b) || (x.a === b && x.b === a);
    });
    const base = idx >= 0 ? Object.assign({}, list[idx]) : { a: a, b: b, from: "", to: "", note: "" };
    for (const k of ["from", "to", "note", "chapter"]) {
      if (it[k] !== undefined && it[k] !== null && String(it[k]).trim() !== "") base[k] = String(it[k]).trim();
    }
    if (idx >= 0) list[idx] = base; else list.push(base);
  }
  return list;
}
