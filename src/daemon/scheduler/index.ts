import { Cron } from 'croner'
import type { RoleId, Schedule } from '@shared/types'
import { db } from '../db'
import { toSchedule } from '../db/mappers'
import { bus } from '../bus'
import { del, get, HttpError, patch, post } from '../server'
import { id, log, now } from '../util'
import { runHeadless } from '../llm/runner'
import { createSession } from '../pty/manager'
import { getProject, listProjects } from '../services/projects'
import { staleProjects } from '../services/insights'

const jobs = new Map<string, Cron>()
const inFlight = new Set<string>()
const RESULT_MAX = 4000
const ROLES: RoleId[] = ['plan', 'implement', 'bugfix', 'review', 'grunt', 'data']

// ---------- templates (suggestions only — never auto-created) ----------
export interface ScheduleTemplate {
  id: string
  name: string
  cron: string
  role: RoleId
  mode: Schedule['mode']
  needsProject: boolean
  description: string
  prompt: string
}

export const TEMPLATES: ScheduleTemplate[] = [
  {
    id: 'security-scan',
    name: 'Nightly security scan',
    cron: '0 2 * * *',
    role: 'review',
    mode: 'headless',
    needsProject: true,
    description: 'Read-only security pass over the repo at 2am; findings land in the schedule result.',
    prompt: [
      'Nightly security scan of this repo. READ-ONLY: do not edit files, commit, push, or install anything.',
      'Check: dependency advisories (run the package manager audit), secrets committed to git, missing auth/authorization on',
      'routes, injection (SQL/command/XSS), unsafe CORS/cookies, and anything changed in the last 24h (git log --since=24.hours).',
      'Reply ≤ 250 words: findings ranked by severity with file:line, or "No new issues".',
    ].join(' '),
  },
  {
    id: 'morning-brief',
    name: 'Morning catch-up brief across projects',
    cron: '0 7 * * 1-5',
    role: 'grunt',
    mode: 'headless',
    needsProject: false,
    description: 'Weekday 7am summary of what moved overnight in every active project.',
    prompt: [
      'Morning brief, {{date}}. For each project below, run `git -C <path> log --since=yesterday --oneline` (read-only)',
      'and skim docs/plan/PROGRESS.md if present. Reply ≤ 200 words: one line per project that changed, then the 3 things most',
      'worth the user\'s attention today. Skip projects with no activity.\n\nProjects:\n{{projects}}',
    ].join(' '),
  },
  {
    id: 'stale-nudge',
    name: 'Weekly stale-project nudge',
    cron: '0 9 * * 1',
    role: 'grunt',
    mode: 'headless',
    needsProject: false,
    description: 'Monday 9am: a short, concrete next step for each project untouched 14+ days.',
    prompt: [
      'These projects have gone quiet (days idle, open work, next task). For each, write one line: a concrete',
      '≤30-minute next step that restarts momentum. Warm but brief, ≤ 150 words total. No tools needed.\n\n{{stale}}',
    ].join(' '),
  },
]

function expand(prompt: string) {
  return prompt
    .replace('{{date}}', new Date().toDateString())
    .replace('{{projects}}', () =>
      listProjects()
        .map((p) => `- ${p.name} — ${p.path}${p.goal ? ` — ${p.goal}` : ''}`)
        .join('\n'),
    )
    .replace('{{stale}}', () =>
      staleProjects(14)
        .map((s) => `- ${s.name}: ${s.staleDays}d idle, ${s.openTasks} open tasks${s.nextTask ? `, next: ${s.nextTask}` : ''}`)
        .join('\n') || '(none stale)',
    )
}

// ---------- CRUD ----------
export function listSchedules(): (Schedule & { nextRunAt: number | null; running: boolean })[] {
  return db
    .prepare('SELECT * FROM schedules ORDER BY name')
    .all()
    .map((r) => toSchedule(r as any))
    .map((s) => ({ ...s, nextRunAt: jobs.get(s.id)?.nextRun()?.getTime() ?? null, running: inFlight.has(s.id) }))
}

export function getSchedule(sid: string): Schedule | null {
  const r = db.prepare('SELECT * FROM schedules WHERE id = ?').get(sid)
  return r ? toSchedule(r) : null
}

function validate(s: Pick<Schedule, 'cron' | 'role' | 'mode' | 'projectId' | 'prompt' | 'name'>) {
  if (!s.name?.trim()) throw new Error('Name is required')
  if (!s.prompt?.trim()) throw new Error('Prompt is required')
  if (!ROLES.includes(s.role)) throw new Error(`Unknown role ${s.role}`)
  if (s.mode !== 'headless' && s.mode !== 'session') throw new Error('mode must be headless or session')
  if (s.mode === 'session' && !s.projectId) throw new Error('Session schedules need a project')
  if (s.projectId && !getProject(s.projectId)) throw new Error('Unknown project')
  try {
    new Cron(s.cron, { paused: true }).stop()
  } catch (e) {
    throw new Error(`Invalid cron "${s.cron}": ${e instanceof Error ? e.message : e}`)
  }
}

export function createSchedule(input: Partial<Schedule> & { templateId?: string }): Schedule {
  const tpl = input.templateId ? TEMPLATES.find((t) => t.id === input.templateId) : undefined
  const s = {
    id: id('sch'),
    name: input.name ?? tpl?.name ?? '',
    cron: input.cron ?? tpl?.cron ?? '',
    projectId: input.projectId ?? null,
    role: input.role ?? tpl?.role ?? 'grunt',
    prompt: input.prompt ?? tpl?.prompt ?? '',
    mode: input.mode ?? tpl?.mode ?? 'headless',
    enabled: input.enabled ?? true,
  }
  validate(s)
  db.prepare(
    `INSERT INTO schedules(id, name, cron, project_id, role, prompt, mode, enabled) VALUES(@id, @name, @cron, @projectId, @role, @prompt, @mode, @enabled)`,
  ).run({ ...s, enabled: s.enabled ? 1 : 0 })
  arm(getSchedule(s.id)!)
  bus.invalidate('schedules')
  return getSchedule(s.id)!
}

const FIELDS: Record<string, string> = { name: 'name', cron: 'cron', projectId: 'project_id', role: 'role', prompt: 'prompt', mode: 'mode', enabled: 'enabled' }

export function updateSchedule(sid: string, p: Partial<Schedule>): Schedule {
  const cur = getSchedule(sid)
  if (!cur) throw new Error('Unknown schedule')
  const next = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([k, v]) => FIELDS[k] && v !== undefined)) }
  validate(next)
  const keys = Object.keys(p).filter((k) => FIELDS[k] && (p as any)[k] !== undefined)
  if (keys.length)
    db.prepare(`UPDATE schedules SET ${keys.map((k) => `${FIELDS[k]} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => (typeof (p as any)[k] === 'boolean' ? ((p as any)[k] ? 1 : 0) : (p as any)[k])),
      sid,
    )
  const s = getSchedule(sid)!
  arm(s)
  bus.invalidate('schedules')
  return s
}

export function deleteSchedule(sid: string) {
  disarm(sid)
  db.prepare('DELETE FROM schedules WHERE id = ?').run(sid)
  bus.invalidate('schedules')
}

// ---------- engine ----------
function disarm(sid: string) {
  jobs.get(sid)?.stop()
  jobs.delete(sid)
}

function arm(s: Schedule) {
  disarm(s.id)
  if (!s.enabled) return
  try {
    const job = new Cron(s.cron, { name: `helm:${s.id}`, protect: true, catch: (e) => log(`schedule ${s.name} failed`, e) }, () => {
      runSchedule(s.id).catch((e) => log(`schedule ${s.name} failed`, e))
    })
    jobs.set(s.id, job)
  } catch (e) {
    log(`schedule ${s.name}: bad cron "${s.cron}"`, e)
  }
}

/** Load enabled schedules and (re)arm their cron jobs. Safe to call repeatedly. */
export function startScheduler() {
  for (const sid of [...jobs.keys()]) disarm(sid)
  const all = (db.prepare('SELECT * FROM schedules WHERE enabled = 1').all() as any[]).map(toSchedule)
  for (const s of all) arm(s)
  log(`scheduler: ${jobs.size} schedule(s) armed`)
}

export function stopScheduler() {
  for (const sid of [...jobs.keys()]) disarm(sid)
}

function record(sid: string, result: string) {
  const r = result.length > RESULT_MAX ? result.slice(0, RESULT_MAX - 1) + '…' : result
  db.prepare('UPDATE schedules SET last_run_at = ?, last_result = ? WHERE id = ?').run(now(), r, sid)
  bus.invalidate('schedules')
}

export async function runSchedule(sid: string): Promise<{ sessionId?: string; result?: string }> {
  const s = getSchedule(sid)
  if (!s) throw new Error('Unknown schedule')
  if (inFlight.has(sid)) throw new Error(`"${s.name}" is already running`)
  const project = s.projectId ? getProject(s.projectId) : null
  if (s.projectId && !project) throw new Error('Schedule project no longer exists')
  const prompt = expand(s.prompt)

  if (s.mode === 'session') {
    let session
    try {
      session = createSession({ projectId: project!.id, role: s.role, prompt, name: s.name })
    } catch (e) {
      record(sid, `Error: ${e instanceof Error ? e.message : e}`)
      throw e
    }
    record(sid, `Started session ${session.name} (${session.id})`)
    bus.toast('info', `Scheduled: ${s.name} started`)
    return { sessionId: session.id }
  }

  inFlight.add(sid)
  bus.invalidate('schedules')
  try {
    const res = await runHeadless({ role: s.role, prompt, cwd: project?.path, tools: 'all', timeoutMs: 30 * 60_000 })
    const text = res.text.trim() || '(no output)'
    record(sid, text)
    bus.toast('success', `${s.name}: ${text.replace(/\s+/g, ' ').slice(0, 140)}`)
    return { result: text }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    record(sid, `Error: ${msg}`)
    bus.toast('error', `${s.name} failed: ${msg.slice(0, 140)}`)
    throw e
  } finally {
    inFlight.delete(sid)
    bus.invalidate('schedules')
  }
}

// ---------- routes ----------
const bad = (e: unknown) => new HttpError(400, e instanceof Error ? e.message : String(e))
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw bad(e)
  }
}

export function registerScheduleRoutes() {
  get('/schedules/templates', () => TEMPLATES)
  get('/schedules', () => listSchedules())
  post('/schedules', ({ body }) => guard(() => createSchedule(body || {})))
  get('/schedules/:id', ({ params }) => {
    const s = getSchedule(params.id)
    if (!s) throw new HttpError(404, 'Not found')
    return s
  })
  patch('/schedules/:id', ({ params, body }) => guard(() => updateSchedule(params.id, body || {})))
  del('/schedules/:id', ({ params }) => (deleteSchedule(params.id), { ok: true }))
  post('/schedules/:id/run', ({ params }) => {
    const s = getSchedule(params.id)
    if (!s) throw new HttpError(404, 'Not found')
    if (inFlight.has(s.id)) throw new HttpError(409, `"${s.name}" is already running`)
    if (s.mode === 'session') return runSchedule(s.id).catch((e) => Promise.reject(bad(e)))
    runSchedule(s.id).catch(() => {}) // headless can take minutes — result arrives via toast + invalidate 'schedules'
    return { started: true }
  })
}
