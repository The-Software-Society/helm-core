import { db } from '../db'
import { DAY, now } from '../util'
import { get } from '../server'
import { usageByDay } from '../transcripts/indexer'

export interface StaleProject {
  projectId: string
  name: string
  kind: string
  staleDays: number
  openTasks: number
  openMilestones: number
  nextTask: string | null
}

export function staleProjects(days = 14): StaleProject[] {
  const cutoff = now() - days * DAY
  const rows = db
    .prepare(
      `SELECT p.id projectId, p.name, p.kind, COALESCE(p.last_activity_at, p.created_at) last,
         (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','wont_do','backlog') AND t.archived_at IS NULL) openTasks,
         (SELECT count(*) FROM milestones m WHERE m.project_id = p.id AND m.status != 'done') openMilestones,
         (SELECT t.title FROM tasks t WHERE t.project_id = p.id AND t.status IN ('in_progress','todo','blocked') AND t.archived_at IS NULL
            ORDER BY (t.status='in_progress') DESC, t.priority, t.ord LIMIT 1) nextTask
       FROM projects p WHERE p.archived = 0 AND COALESCE(p.last_activity_at, p.created_at) < ?`,
    )
    .all(cutoff) as (Omit<StaleProject, 'staleDays'> & { last: number })[]
  return rows
    .filter((r) => r.openTasks > 0 || r.openMilestones > 0)
    .map(({ last, ...r }) => ({ ...r, staleDays: Math.floor((now() - last) / DAY) }))
    .sort((a, b) => b.staleDays - a.staleDays)
}

function weekStart(ms: number) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // Monday
  return d.getTime()
}

export function throughput(weeks = 8) {
  const start = weekStart(now()) - (weeks - 1) * 7 * DAY
  const rows = db
    .prepare(
      `SELECT t.project_id projectId, p.name, p.color, t.completed_at at FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.status = 'done' AND t.completed_at >= ?`,
    )
    .all(start) as { projectId: string; name: string; color: string; at: number }[]
  const weekStarts = Array.from({ length: weeks }, (_, i) => start + i * 7 * DAY)
  const by = new Map<string, { projectId: string; name: string; color: string; perWeek: number[]; total: number }>()
  for (const r of rows) {
    let p = by.get(r.projectId)
    if (!p) by.set(r.projectId, (p = { projectId: r.projectId, name: r.name, color: r.color, perWeek: Array(weeks).fill(0), total: 0 }))
    // DST-safe bucket: last week start <= completed_at
    let i = weekStarts.length - 1
    while (i > 0 && weekStarts[i] > r.at) i--
    p.perWeek[i]++
    p.total++
  }
  return { weekStarts, projects: [...by.values()].sort((a, b) => b.total - a.total) }
}

export function usageSummary(days = 30) {
  const buckets = usageByDay(days) as { day: string; provider: string; model: string; tokensIn: number; tokensOut: number; sessions: number }[]
  const byDay = new Map<string, { day: string; tokensIn: number; tokensOut: number }>()
  const byModel = new Map<string, { provider: string; model: string; tokensIn: number; tokensOut: number; sessions: number }>()
  let tokensIn = 0
  let tokensOut = 0
  for (const b of buckets) {
    tokensIn += b.tokensIn
    tokensOut += b.tokensOut
    const d = byDay.get(b.day) || { day: b.day, tokensIn: 0, tokensOut: 0 }
    d.tokensIn += b.tokensIn
    d.tokensOut += b.tokensOut
    byDay.set(b.day, d)
    const k = `${b.provider}/${b.model}`
    const m = byModel.get(k) || { provider: b.provider, model: b.model, tokensIn: 0, tokensOut: 0, sessions: 0 }
    m.tokensIn += b.tokensIn
    m.tokensOut += b.tokensOut
    m.sessions += b.sessions
    byModel.set(k, m)
  }
  return {
    days, tokensIn, tokensOut,
    byDay: [...byDay.values()],
    byModel: [...byModel.values()].sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut)),
  }
}

export function insights() {
  return { throughput: throughput(8), usage: usageSummary(30), stale: staleProjects(14) }
}

export function registerInsightsRoutes() {
  get('/insights', () => insights())
}
