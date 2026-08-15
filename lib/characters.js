/**
 * 人物动态状态层：设定卡是"他是谁"（静态），这里是"他此刻要什么、怕什么、刚失去什么"（动态）。
 * 落盘项目根 characters.json。生成章节时注入，作为模型推演人物选择的事实依据——
 * 让人物在情境中的选择可推导，而不是由指令规定。
 */

const FILE = "characters.json"

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
  if (!list.length) return "";
  const parts = ["【人物此刻的状态】"];
  for (const c of list) {
    const bits = [];
    if (c.want) bits.push("想要：" + c.want);
    if (c.fear) bits.push("害怕：" + c.fear);
    if (c.lost) bits.push("刚失去：" + c.lost);
    if (c.relation) bits.push("人际：" + c.relation);
    if (!bits.length) continue;
    parts.push("- " + c.name + "：" + bits.join("；"));
  }
  return parts.length > 1 ? parts.join("\n") + "\n" : "";
}
