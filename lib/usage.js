/**
 * 用量记账：独立分流 key 的调用与 token 统计（新增模块，不改引擎家底）。
 * 数据落盘 $DSH_HOME/writing-usage.json；条目上限裁剪，防止无限增长。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const MAX_ENTRIES = 2000

function usagePath() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')
  return join(home, 'writing-usage.json')
}

function load() {
  try {
    if (!existsSync(usagePath())) return []
    return JSON.parse(readFileSync(usagePath(), 'utf8'))
  } catch { return [] }
}

/** 追加一条记账。entry: {model, ok, promptTokens, completionTokens, cacheHit, cacheMiss, durationMs, tag, error} */
export function recordUsage(entry) {
  try {
    entry = entry || {}
    const list = load()
    list.push({ ts: new Date().toISOString(), ...entry })
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
    const p = usagePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(list, null, 2))
  } catch { /* 记账失败绝不拖垮生成 */ }
}

/** 默认单价（元/百万 token）：自定义人民币价，传入 override 时启用（旧行为） */
export function priceTable(override) {
  return {
    inputMiss: 2,
    inputHit: 0.5,
    output: 8,
    ...(override || {}),
  }
}

/**
 * 官方 V4 价（美元/百万 token），来源 api-docs.deepseek.com/quick_start/pricing
 * 8/16 16:00 UTC 之前为 flat 价；之后峰谷计价，谷价 = 峰价一半。
 * 峰时段：UTC 01:00-04:00 与 06:00-10:00（北京 09:00-12:00 / 14:00-18:00）。
 */
const FLAT_PRICE = {
  'deepseek-v4-flash': { hit: 0.0028, miss: 0.14, out: 0.28 },
  'deepseek-v4-pro': { hit: 0.003625, miss: 0.435, out: 0.87 },
}
const PEAK_PRICE = {
  'deepseek-v4-flash': { peak: { hit: 0.014, miss: 0.44, out: 1.32 }, off: { hit: 0.007, miss: 0.22, out: 0.66 } },
  'deepseek-v4-pro': { peak: { hit: 0.044, miss: 1.32, out: 3.96 }, off: { hit: 0.022, miss: 0.66, out: 1.98 } },
}
const PEAK_SINCE = Date.UTC(2026, 7, 16, 16, 0, 0) // 2026-08-16T16:00:00Z
const USD_RATE = 7.2 // 1 美元 ≈ 7.2 元，展示用，可在 overridePrices.rate 覆盖

/** 按条目时间与模型自动选官方美元单价 */
export function usdPriceFor(e) {
  const model = String((e && e.model) || 'deepseek-v4-flash')
  const pro = model.indexOf('v4-pro') >= 0
  const key = pro ? 'deepseek-v4-pro' : 'deepseek-v4-flash'
  const ts = e && e.ts ? new Date(e.ts) : null
  if (ts && ts.getTime() >= PEAK_SINCE) {
    const h = ts.getUTCHours()
    const peak = (h >= 1 && h < 4) || (h >= 6 && h < 10)
    const row = PEAK_PRICE[key][peak ? 'peak' : 'off']
    return { hit: row.hit, miss: row.miss, out: row.out, tier: peak ? 'peak' : 'off' }
  }
  const row = FLAT_PRICE[key]
  return { hit: row.hit, miss: row.miss, out: row.out, tier: 'flat' }
}

/** 估算成本：传 override 走人民币自定义价（旧行为），否则走官方美元价 */
export function costOf(e, override) {
  const hit = e.cacheHit || 0
  const miss = e.promptTokens - hit > 0 ? e.promptTokens - hit : 0
  const out = e.completionTokens || 0
  if (override && (override.inputMiss !== undefined || override.inputHit !== undefined || override.output !== undefined)) {
    const p = priceTable(override)
    return (hit * p.inputHit + miss * p.inputMiss + out * p.output) / 1e6
  }
  const u = usdPriceFor(e)
  return (hit * u.hit + miss * u.miss + out * u.out) / 1e6
}

/** 汇总统计：总量 + 按模型 + 按日期 + 按结果，含估算费用 */
export function summarize(overridePrices) {
  const list = load()
  const p = priceTable(overridePrices)
  const total = { calls: 0, ok: 0, fail: 0, prompt: 0, completion: 0, cacheHit: 0, cost: 0, durationMs: 0 }
  const byModel = {}
  const byDate = {}
  const byEffort = {}
  for (const e of list) {
    total.calls++
    if (e.ok) total.ok++; else total.fail++
    total.prompt += e.promptTokens || 0
    total.completion += e.completionTokens || 0
    total.cacheHit += e.cacheHit || 0
    total.cost += costOf(e, overridePrices)
    total.durationMs += e.durationMs || 0
    const m = e.model || '?'
    byModel[m] = byModel[m] || { calls: 0, prompt: 0, completion: 0, cost: 0 }
    byModel[m].calls++
    byModel[m].prompt += e.promptTokens || 0
    byModel[m].completion += e.completionTokens || 0
    byModel[m].cost += costOf(e, overridePrices)
    const day = String(e.ts || '').slice(0, 10)
    byDate[day] = byDate[day] || { calls: 0, cost: 0 }
    byDate[day].calls++
    byDate[day].cost += costOf(e, overridePrices)
    const ef = e.effort || '-'
    byEffort[ef] = byEffort[ef] || { calls: 0, prompt: 0, completion: 0, cost: 0 }
    byEffort[ef].calls++
    byEffort[ef].prompt += e.promptTokens || 0
    byEffort[ef].completion += e.completionTokens || 0
    byEffort[ef].cost += costOf(e, overridePrices)
  }
  const isCny = !!(overridePrices && (overridePrices.inputMiss !== undefined || overridePrices.inputHit !== undefined || overridePrices.output !== undefined))
  return { total, byModel, byDate, byEffort, entries: list.length, mode: isCny ? "cny" : "usd" }
}

/** 供 novel_usage 工具使用的文本报表 */
export function report(overridePrices) {
  const s = summarize(overridePrices)
  const cny = s.mode === 'cny'
  const rate = (overridePrices && overridePrices.rate) || USD_RATE
  const fee = function (v) {
    if (cny) return '¥' + v.toFixed(4)
    return '$' + v.toFixed(4) + '（约 ¥' + (v * rate).toFixed(2) + '）'
  }
  const lines = []
  lines.push('【写文引擎用量总账】（独立分流 key）')
  lines.push('调用次数: ' + s.total.calls + '（成功 ' + s.total.ok + ' / 失败 ' + s.total.fail + '）')
  lines.push('输入 token: ' + s.total.prompt + '（缓存命中 ' + s.total.cacheHit + '）')
  lines.push('输出 token: ' + s.total.completion)
  lines.push('累计耗时: ' + (s.total.durationMs / 1000).toFixed(0) + ' 秒')
  lines.push('估算费用: ' + fee(s.total.cost))
  if (!cny) lines.push('计价口径: 官方 V4 美元价（8/16 16:00 UTC 前 flat；之后峰谷，峰=UTC 1-4/6-10 即北京 9-12/14-18，谷价减半；汇率 ' + rate + ' 可覆盖）')
  if (Object.keys(s.byModel).length) {
    lines.push('')
    lines.push('按模型:')
    for (const [m, v] of Object.entries(s.byModel)) {
      lines.push('- ' + m + ': ' + v.calls + ' 次, 输入 ' + v.prompt + ', 输出 ' + v.completion + ', ' + fee(v.cost))
    }
  }
  const efforts = Object.keys(s.byEffort)
  if (efforts.length) {
    lines.push('')
    lines.push('按思考档位:')
    const order = { low: 0, high: 1, max: 2 }
    efforts.sort(function (a, b) { return (order[a] === undefined ? 9 : order[a]) - (order[b] === undefined ? 9 : order[b]); })
    for (const ef of efforts) {
      const v = s.byEffort[ef]
      lines.push('- ' + ef + ': ' + v.calls + ' 次, 输入 ' + v.prompt + ', 输出 ' + v.completion + ', ' + fee(v.cost))
    }
  }
  const days = Object.keys(s.byDate).sort().slice(-7)
  if (days.length) {
    lines.push('')
    lines.push('最近 7 天:')
    for (const d of days) lines.push('- ' + d + ': ' + s.byDate[d].calls + ' 次, ' + fee(s.byDate[d].cost))
  }
  return lines.join('\n')
}
