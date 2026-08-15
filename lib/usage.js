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

/** 默认单价（元/百万 token）：deepseek-chat 官方价，可配置覆盖 */
export function priceTable(override) {
  return {
    inputMiss: 2,
    inputHit: 0.5,
    output: 8,
    ...(override || {}),
  }
}

export function costOf(e, prices) {
  const p = priceTable(prices)
  const hit = e.cacheHit || 0
  const miss = e.promptTokens - hit > 0 ? e.promptTokens - hit : 0
  const out = e.completionTokens || 0
  return (hit * p.inputHit + miss * p.inputMiss + out * p.output) / 1e6
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
  return { total, byModel, byDate, byEffort, entries: list.length, prices: p }
}

/** 供 novel_usage 工具使用的文本报表 */
export function report(overridePrices) {
  const s = summarize(overridePrices)
  const lines = []
  lines.push('【写文引擎用量总账】（独立分流 key）')
  lines.push('调用次数: ' + s.total.calls + '（成功 ' + s.total.ok + ' / 失败 ' + s.total.fail + '）')
  lines.push('输入 token: ' + s.total.prompt + '（缓存命中 ' + s.total.cacheHit + '）')
  lines.push('输出 token: ' + s.total.completion)
  lines.push('累计耗时: ' + (s.total.durationMs / 1000).toFixed(0) + ' 秒')
  lines.push('估算费用: ¥' + s.total.cost.toFixed(4) + '（单价 输入¥' + s.prices.inputMiss + '/M 命中¥' + s.prices.inputHit + '/M 输出¥' + s.prices.output + '/M，可配置）')
  if (Object.keys(s.byModel).length) {
    lines.push('')
    lines.push('按模型:')
    for (const [m, v] of Object.entries(s.byModel)) {
      lines.push('- ' + m + ': ' + v.calls + ' 次, 输入 ' + v.prompt + ', 输出 ' + v.completion + ', ¥' + v.cost.toFixed(4))
    }
  }
  const efforts = Object.keys(s.byEffort)
  if (efforts.length) {
    lines.push("")
    lines.push("按思考档位:")
    const order = { low: 0, high: 1, max: 2 }
    efforts.sort(function (a, b) { return (order[a] === undefined ? 9 : order[a]) - (order[b] === undefined ? 9 : order[b]); })
    for (const ef of efforts) {
      const v = s.byEffort[ef]
      lines.push("- " + ef + ": " + v.calls + " 次, 输入 " + v.prompt + ", 输出 " + v.completion + ", \u00a5" + v.cost.toFixed(4))
    }
  }
  const days = Object.keys(s.byDate).sort().slice(-7)
  if (days.length) {
    lines.push('')
    lines.push('最近 7 天:')
    for (const d of days) lines.push('- ' + d + ': ' + s.byDate[d].calls + ' 次, ¥' + s.byDate[d].cost.toFixed(4))
  }
  return lines.join('\n')
}
