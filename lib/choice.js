/**
 * 写作交互模式：每章走向抉择（文件协议 .writing-choice.json）。
 * 主 agent 推演走向 → 写 pending → 写作面板小窗展示 → 作者选择/扩写 → 写 answered → 主 agent 轮询取答。
 */

const CHOICE_FILE = ".writing-choice.json"

export async function readChoice(engine) {
  try { return JSON.parse(await engine.readText(CHOICE_FILE)); } catch (e) { return null; }
}

export async function writeChoice(engine, choice) {
  await engine.writeText(CHOICE_FILE, JSON.stringify(choice, null, 2));
}

/** LLM 推演 N 个走向（标题/展开/利弊），返回 options 数组 */
export async function generateOptions(engine, fork, context, count) {
  const raw = await engine.generate({
    effort: "high",
    system: "你是叙事策划师。基于当前局势为故事推演可能的走向。每个走向要具体、可执行、有因果后果；避免陈词滥调，鼓励出人意料但自洽的方向；走向之间要有实质差异。",
    prompt: "【当前局势】" + fork + (context ? "\n【相关上下文】" + context : "") + "\n请推演 " + count + " 个走向，输出 JSON：" + JSON_TMPL,
    json: true,
    maxTokens: 2000
  });
  const cleaned = String(raw).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let obj;
  try { obj = JSON.parse(cleaned); } catch (e) { return []; }
  const list = Array.isArray(obj.options) ? obj.options : [];
  const out = [];
  for (let i = 0; i < list.length && i < 5; i++) {
    const o = list[i] || {};
    if (!o.title) continue;
    out.push({ id: String.fromCharCode(65 + i), title: String(o.title), outline: String(o.outline || ""), pros: Array.isArray(o.pros) ? o.pros.map(String) : [], cons: Array.isArray(o.cons) ? o.cons.map(String) : [] });
  }
  return out;
}

export function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// JSON 模板常量
const JSON_TMPL = "{\"options\":[{\"title\":\"走向名\",\"outline\":\"这个走向如何展开（120字内）\",\"pros\":[\"利\"],\"cons\":[\"弊\"]}]}";
