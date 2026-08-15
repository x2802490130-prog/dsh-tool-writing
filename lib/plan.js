/**
 * 连载计划（本地架子）：目标 → 每日产出 → 存稿余量。
 * 不做平台发布对接（无可靠接口），发布记录由作者自行在对应平台粘贴发布。
 * 数据落盘项目根 plan.json，与 manifest 章节进度联动计算。
 */
const DEFAULTS = {
  goal: { targetChapters: 0, targetWords: 0, endDate: '' },
  schedule: [],
}

export function planDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS))
}

/** 从项目根读取 plan.json；不存在返回默认 */
export async function planLoad(engine) {
  try {
    const t = await engine.readText('plan.json')
    const j = JSON.parse(t)
    return { ...planDefaults(), ...j }
  } catch { return planDefaults() }
}

export async function planSave(engine, plan) {
  await engine.writeText('plan.json', JSON.stringify(plan, null, 2))
}

/** 纯计算：基于 manifest 章节进度 + 计划目标 */
export function compute(manifest, plan) {
  const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : []
  const doneChapters = chapters.length
  const doneWords = chapters.reduce((s, c) => s + (Number(c.words) || 0), 0)
  const goal = plan.goal || {}
  const targetChapters = Number(goal.targetChapters) || 0
  const targetWords = Number(goal.targetWords) || 0
  const remainingChapters = Math.max(0, targetChapters - doneChapters)
  const remainingWords = Math.max(0, targetWords - doneWords)
  const endDate = String(goal.endDate || '')
  let daysLeft = null
  if (endDate) {
    const end = new Date(endDate)
    const today = new Date()
    end.setHours(23, 59, 59, 0)
    today.setHours(0, 0, 0, 0)
    daysLeft = Math.max(0, Math.ceil((end.getTime() - today.getTime()) / 86400e3))
  }
  const dailyWords = daysLeft !== null && daysLeft > 0 ? Math.ceil(remainingWords / daysLeft) : null
  const dailyChapters = daysLeft !== null && daysLeft > 0 ? Number((remainingChapters / daysLeft).toFixed(1)) : null
  const backlog = doneChapters // 存稿余量（未接入平台发布，全部已写章节即存稿）
  return {
    doneChapters, doneWords, remainingChapters, remainingWords,
    daysLeft, dailyWords, dailyChapters, backlog,
    targetChapters, targetWords,
  }
}

/** 供 novel_plan 工具使用的文本视图 */
export function planView(manifest, plan) {
  const c = compute(manifest, plan)
  const lines = []
  lines.push('【连载计划】')
  const g = plan.goal || {}
  lines.push('目标: ' + (g.targetChapters ? g.targetChapters + ' 章' : '未设') + (g.targetWords ? ' / ' + g.targetWords + ' 字' : '') + (g.endDate ? ' / ' + g.endDate + ' 完本' : ''))
  lines.push('进度: 已写 ' + c.doneChapters + ' 章 / ' + c.doneWords + ' 字（存稿 ' + c.backlog + ' 章）')
  if (c.targetChapters || c.targetWords) {
    lines.push('剩余: ' + c.remainingChapters + ' 章 / ' + c.remainingWords + ' 字')
    if (c.daysLeft !== null) {
      lines.push('距完本: ' + c.daysLeft + ' 天 → 每日需 ' + c.dailyWords + ' 字（约 ' + c.dailyChapters + ' 章）')
    } else {
      lines.push('未设完本日期，先设定目标与 endDate 才能算出每日产出')
    }
  } else {
    lines.push('未设目标，用 novel_plan set-goal 设定（目标章数/字数/完本日期）')
  }
  const sch = Array.isArray(plan.schedule) ? plan.schedule : []
  if (sch.length) {
    lines.push('')
    lines.push('排期记录（最近 10 条）:')
    for (const s of sch.slice(-10)) {
      lines.push('- ' + (s.date || '?') + ' | ' + (s.plan || '') + ' | ' + (s.done ? '已完成' : '待办'))
    }
  }
  return lines.join('\n')
}
