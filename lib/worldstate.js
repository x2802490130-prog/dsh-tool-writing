/**
 * 世界状态层：设定卡是"世界是什么"（静态描述），这里是"世界此刻的具体锚点"（动态事实）。
 * 落盘项目根 world-state.json。生成章节时注入，作为事实约束防止内部漂移——
 * 称谓统一（诊所≠卫生所）、物证位置（铜扣在谁手里、来自哪里）、关键地点状态。
 * 每章 sync 时由状态抽取步骤自动更新（世界在推进，状态跟着走）。
 */

const FILE = "world-state.json";

export async function loadWorldState(engine) {
  try {
    const j = JSON.parse(await engine.readText(FILE));
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    return {};
  }
}

export async function saveWorldState(engine, data) {
  await engine.writeText(FILE, JSON.stringify(data, null, 2));
}

function renderList(items, prefix, mapper) {
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  for (const it of list) {
    const line = mapper(it);
    if (line) parts.push(prefix + line);
  }
  return parts;
}

/** 渲染为提示文本（注入生成上下文），紧凑省 token */
export function worldStateContext(data) {
  data = data || {};
  const lines = [];
  const terms = Array.isArray(data.terms) ? data.terms : [];
  if (terms.length) {
    const ts = terms.map(function (t) {
      const aliases = Array.isArray(t.aliases) && t.aliases.length ? "（勿写作：" + t.aliases.join("/") + "）" : "";
      return t.canonical + aliases + (t.note ? "——" + t.note : "");
    });
    lines.push("- 称谓统一：" + ts.join("；"));
  }
  // 防膨胀：注入时每类限量（数组尾=最近更新，取尾部最新条目）
  lines.push.apply(lines, renderList((data.places || []).slice(-8), "- 地点：", function (p) { return p.name + (p.note ? "——" + p.note : ""); }));
  lines.push.apply(lines, renderList((data.people || []).slice(-8), "- 人物：", function (p) { return p.name + (p.role ? "（" + p.role + "）" : "") + (p.note ? "——" + p.note : ""); }));
  lines.push.apply(lines, renderList((data.objects || []).slice(-10), "- 物证：", function (o) {
    const layer = o.layer ? "｜第" + o.layer + "层" : "";
    const note = o.layerNote ? "（已知：" + o.layerNote + "）" : (o.source ? "（来自：" + o.source + "）" : "");
    return o.name + (o.location ? "→" + o.location : "") + layer + note;
  }));
  if (!lines.length) return "";
  return "【世界状态（称谓与物证的当前事实，写作时保持一致）】\n" + lines.join("\n") + "\n";
}

/** 按 name upsert 合并补丁（非空字段才覆盖，避免空值冲掉已有状态） */
function upsertByName(arr, patchItems) {
  const list = Array.isArray(arr) ? arr.slice() : [];
  for (const it of (Array.isArray(patchItems) ? patchItems : [])) {
    const name = String((it && it.name) || "").trim();
    if (!name) continue;
    const idx = list.findIndex(function (x) { return String(x.name || "").trim() === name; });
    const base = idx >= 0 ? Object.assign({}, list[idx]) : { name: name };
    for (const k of ["note", "location", "source", "role", "chapter", "layer", "layerNote"]) {
      if (it[k] !== undefined && it[k] !== null && String(it[k]).trim() !== "") base[k] = it[k];
    }
    if (Array.isArray(it.aliases) && it.aliases.length) {
      base.aliases = Array.from(new Set((base.aliases || []).concat(it.aliases.map(String))));
    }
    // 命中即移到末尾（数组尾=最近更新，渲染 cap 时优先保留最新）
    if (idx >= 0) list.splice(idx, 1);
    list.push(base);
  }
  return list;
}

export function mergeWorldState(data, patch) {
  data = data || {};
  patch = patch || {};
  data.terms = upsertByName(data.terms, patch.terms);
  data.places = upsertByName(data.places, patch.places);
  data.people = upsertByName(data.people, patch.people);
  data.objects = upsertByName(data.objects, patch.objects);
  // 防膨胀：物证表最多保留最近 40 条（数组尾=最近更新）
  if (data.objects.length > 40) data.objects = data.objects.slice(-40);
  data.updatedAt = new Date().toISOString();
  return data;
}
