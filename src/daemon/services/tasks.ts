import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Evidence, Milestone, RoleId, Task, TaskEvent, TaskStatus } from '@shared/types'
import { TASK_STATUS_LABELS } from '@shared/types'
import { db } from '../db'
import { toEvidence, toMilestone, toTask, toTaskEvent } from '../db/mappers'
import { bus } from '../bus'
import { id, now } from '../util'
import { getProject, touchProject, updateProject } from './projects'

// ---------- milestones ----------
export function listMilestones(projectId: string): Milestone[] {
  return db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY ord, created_at').all(projectId).map(toMilestone)
}

export function getMilestone(mid: string): Milestone | null {
  const r = db.prepare('SELECT * FROM milestones WHERE id = ?').get(mid)
  return r ? toMilestone(r) : null
}

export function createMilestone(input: { projectId: string; title: string; description?: string; status?: Milestone['status'] }) {
  const ord = (db.prepare('SELECT COALESCE(max(ord), -1) + 1 o FROM milestones WHERE project_id = ?').get(input.projectId) as { o: number }).o
  const m = { id: id('ms'), project_id: input.projectId, title: input.title, description: input.description || '', ord, status: input.status || 'planned', created_at: now() }
  db.prepare('INSERT INTO milestones VALUES(@id, @project_id, @title, @description, @ord, @status, @created_at)').run(m)
  const ms = getMilestone(m.id)!
  bus.emitEvent({ t: 'milestone.update', milestone: ms })
  return ms
}

export function updateMilestone(mid: string, patch: Partial<Pick<Milestone, 'title' | 'description' | 'status' | 'order'>>) {
  const map: Record<string, string> = { title: 'title', description: 'description', status: 'status', order: 'ord' }
  const sets = Object.keys(patch).filter((k) => map[k])
  if (sets.length)
    db.prepare(`UPDATE milestones SET ${sets.map((k) => `${map[k]} = ?`).join(', ')} WHERE id = ?`).run(
      ...sets.map((k) => (patch as any)[k]),
      mid,
    )
  if (patch.status === 'active') {
    const ms = getMilestone(mid)!
    db.prepare(`UPDATE milestones SET status = 'planned' WHERE project_id = ? AND id != ? AND status = 'active'`).run(ms.projectId, mid)
    bus.invalidate('milestones')
  }
  const ms = getMilestone(mid)!
  bus.emitEvent({ t: 'milestone.update', milestone: ms })
  return ms
}

export function deleteMilestone(mid: string) {
  db.prepare('DELETE FROM milestones WHERE id = ?').run(mid)
  bus.invalidate('milestones', 'tasks')
}

// ---------- tasks ----------
/** Statuses that end a task. Won't-do is closed but never counts as delivered work. */
export const CLOSED: TaskStatus[] = ['done', 'wont_do']
export type ArchivedFilter = 'exclude' | 'only' | 'include'

/** Archived tasks keep their history but stay out of every list unless asked for. */
export function listTasks(filter: { projectId?: string; status?: TaskStatus[]; milestoneId?: string; archived?: ArchivedFilter } = {}): Task[] {
  const where: string[] = []
  const vals: unknown[] = []
  const archived = filter.archived || 'exclude'
  if (archived !== 'include') where.push(archived === 'only' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL')
  if (filter.projectId) (where.push('project_id = ?'), vals.push(filter.projectId))
  if (filter.milestoneId) (where.push('milestone_id = ?'), vals.push(filter.milestoneId))
  if (filter.status?.length) (where.push(`status IN (${filter.status.map(() => '?').join(',')})`), vals.push(...filter.status))
  return db
    .prepare(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority, ord, created_at`)
    .all(...vals)
    .map(toTask)
}

export function getTask(tid: string): Task | null {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(tid)
  return r ? toTask(r) : null
}

const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** The open, unarchived task with the same title (ignoring case and punctuation), if any. */
export function findOpenTask(projectId: string, title: string): Task | null {
  const key = normTitle(title)
  if (!key) return null
  return listTasks({ projectId }).find((t) => !CLOSED.includes(t.status) && normTitle(t.title) === key) ?? null
}

export function createTask(input: {
  projectId: string
  title: string
  milestoneId?: string | null
  description?: string
  acceptance?: string
  status?: TaskStatus
  role?: RoleId | null
  priority?: number
  createdBy?: string
}): Task {
  const ord = (db.prepare('SELECT COALESCE(max(ord), -1) + 1 o FROM tasks WHERE project_id = ?').get(input.projectId) as { o: number }).o
  const t = now()
  const row = {
    id: id('tsk'), project_id: input.projectId, milestone_id: input.milestoneId ?? null, title: input.title,
    description: input.description || '', acceptance: input.acceptance || '', status: input.status || 'todo',
    role: input.role ?? null, priority: input.priority ?? 2, ord, created_by: input.createdBy || 'user', t,
  }
  db.prepare(
    `INSERT INTO tasks(id, project_id, milestone_id, title, description, acceptance, status, role, priority, ord, created_by, created_at, updated_at)
     VALUES(@id, @project_id, @milestone_id, @title, @description, @acceptance, @status, @role, @priority, @ord, @created_by, @t, @t)`,
  ).run(row)
  const task = getTask(row.id)!
  bus.emitEvent({ t: 'task.update', task })
  return task
}

const TASK_FIELDS: Record<string, string> = {
  title: 'title', description: 'description', acceptance: 'acceptance', status: 'status', role: 'role',
  reviewError: 'review_error', priority: 'priority', order: 'ord', milestoneId: 'milestone_id', sessionId: 'session_id',
  closedReason: 'closed_reason',
}

export function updateTask(tid: string, patch: Partial<Task>, actor = 'user'): Task {
  const before = getTask(tid)
  if (!before) throw new Error(`No task ${tid}`)
  if (patch.status) patch = { ...patch, reviewError: '', ...(CLOSED.includes(patch.status) ? {} : { closedReason: '' }) }
  const keys = Object.keys(patch).filter((k) => TASK_FIELDS[k] && (patch as any)[k] !== undefined)
  if (keys.length) {
    const sets = keys.map((k) => `${TASK_FIELDS[k]} = ?`)
    const vals = keys.map((k) => (patch as any)[k])
    sets.push('updated_at = ?', 'review_version = review_version + 1')
    vals.push(now())
    if (patch.status && CLOSED.includes(patch.status) && patch.status !== before.status) sets.push(`completed_at = ${now()}`)
    if (patch.status && !CLOSED.includes(patch.status)) sets.push('completed_at = NULL')
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, tid)
  }
  if (patch.status && patch.status !== before.status)
    addTaskEvent(tid, 'status', actor, `${TASK_STATUS_LABELS[before.status]} → ${TASK_STATUS_LABELS[patch.status]}${patch.closedReason ? `: ${patch.closedReason}` : ''}`)
  const task = getTask(tid)!
  touchProject(task.projectId)
  bus.emitEvent({ t: 'task.update', task })
  return task
}

/** Close as done or won't-do. The reason is required and kept on the task and in its activity. */
export function closeTask(tid: string, outcome: 'done' | 'wont_do', reason: string, actor = 'user'): Task {
  if (!CLOSED.includes(outcome)) throw new Error('Outcome must be done or wont_do')
  if (!reason?.trim()) throw new Error('Give a reason for closing the task')
  return updateTask(tid, { status: outcome, closedReason: reason.trim() }, actor)
}

/** Soft delete: hidden from lists, reviews and the TSS desk; history, evidence and status are kept and restorable. */
export function archiveTask(tid: string, reason: string, actor = 'user'): Task {
  const t = getTask(tid)
  if (!t) throw new Error(`No task ${tid}`)
  if (t.archivedAt) return t
  db.prepare('UPDATE tasks SET archived_at = ?, archived_reason = ?, updated_at = ? WHERE id = ?').run(now(), (reason || '').trim(), now(), tid)
  addTaskEvent(tid, 'status', actor, `Archived${reason?.trim() ? `: ${reason.trim()}` : ''}`)
  const task = getTask(tid)!
  bus.emitEvent({ t: 'task.update', task })
  return task
}

export function restoreTask(tid: string, actor = 'user'): Task {
  const t = getTask(tid)
  if (!t) throw new Error(`No task ${tid}`)
  if (!t.archivedAt) return t
  db.prepare(`UPDATE tasks SET archived_at = NULL, archived_reason = '', updated_at = ? WHERE id = ?`).run(now(), tid)
  addTaskEvent(tid, 'status', actor, 'Restored from archive')
  const task = getTask(tid)!
  bus.emitEvent({ t: 'task.update', task })
  return task
}

export function deleteTask(tid: string) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(tid)
  bus.emitEvent({ t: 'task.remove', taskId: tid })
}

export function addTaskEvent(taskId: string, kind: TaskEvent['kind'], actor: string, body: string): TaskEvent {
  const e = { id: id('evt'), task_id: taskId, kind, actor, body, created_at: now() }
  db.prepare('INSERT INTO task_events VALUES(@id, @task_id, @kind, @actor, @body, @created_at)').run(e)
  bus.invalidate(`task:${taskId}`)
  return toTaskEvent(e)
}

export function taskEvents(taskId: string): TaskEvent[] {
  return db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at').all(taskId).map(toTaskEvent)
}

export function addEvidence(input: Omit<Evidence, 'id' | 'createdAt'>): Evidence {
  const e = { id: id('evd'), task_id: input.taskId, session_id: input.sessionId, kind: input.kind, title: input.title, path: input.path, body: input.body, created_at: now() }
  db.prepare('INSERT INTO evidence VALUES(@id, @task_id, @session_id, @kind, @title, @path, @body, @created_at)').run(e)
  db.prepare('UPDATE tasks SET review_version = review_version + 1 WHERE id = ?').run(input.taskId)
  addTaskEvent(input.taskId, 'evidence', input.sessionId || 'user', `${input.kind}: ${input.title}`)
  return toEvidence(e)
}

export function listEvidence(taskId: string): Evidence[] {
  return db.prepare('SELECT * FROM evidence WHERE task_id = ? ORDER BY created_at').all(taskId).map(toEvidence)
}

export function getEvidence(eid: string): Evidence | null {
  const r = db.prepare('SELECT * FROM evidence WHERE id = ?').get(eid)
  return r ? toEvidence(r) : null
}

/** AI verdict on a task. Pass → human_review; fail → back to in_progress with notes. */
export function aiReview(taskId: string, verdict: 'pass' | 'fail', notes: string, actor: string) {
  addTaskEvent(taskId, 'review', actor, `AI review ${verdict === 'pass' ? 'passed' : 'failed'}${notes ? `: ${notes}` : ''}`)
  return updateTask(taskId, { status: verdict === 'pass' ? 'human_review' : 'in_progress' }, actor)
}

/** The user's verdict. Approve → done; changes → in_progress with notes (routed to the task's session if alive). */
export function humanReview(taskId: string, verdict: 'approve' | 'changes', notes: string) {
  if (getTask(taskId)?.status !== 'human_review') throw new Error('Task must pass AI review first')
  if (verdict !== 'approve' && verdict !== 'changes') throw new Error('Invalid verdict')
  addTaskEvent(taskId, 'review', 'user', `${verdict === 'approve' ? 'Approved' : 'Changes requested'}${notes ? `: ${notes}` : ''}`)
  return updateTask(taskId, { status: verdict === 'approve' ? 'done' : 'in_progress' })
}

export function reviewQueue() {
  return db
    .prepare(
      `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.status IN ('human_review','ai_review') AND t.archived_at IS NULL AND p.archived = 0 ORDER BY t.status = 'human_review' DESC, t.updated_at DESC`,
    )
    .all()
    .map(toTask)
}

// ---------- plan application / markdown sync ----------
export interface PlanDraft {
  goal?: string
  brief?: string
  milestones: {
    title: string
    description?: string
    status?: Milestone['status']
    tasks: { title: string; description?: string; acceptance?: string; role?: RoleId; priority?: number; status?: TaskStatus }[]
  }[]
}

/** Merge a plan into a project. Matches milestones/tasks by title so re-applying is idempotent. */
export function applyPlan(projectId: string, plan: PlanDraft, actor = 'user') {
  const tx = db.transaction(() => {
    if (plan.goal || plan.brief) updateProject(projectId, { ...(plan.goal ? { goal: plan.goal } : {}), ...(plan.brief ? { brief: plan.brief } : {}) })
    const existingMs = listMilestones(projectId)
    let first = true
    for (const m of plan.milestones) {
      let ms = existingMs.find((x) => x.title.trim().toLowerCase() === m.title.trim().toLowerCase())
      if (!ms) ms = createMilestone({ projectId, title: m.title, description: m.description, status: m.status || (first && !existingMs.some((x) => x.status === 'active') ? 'active' : 'planned') })
      first = false
      // Archived tasks count as existing, so re-applying a plan never brings them back.
      const existingTasks = listTasks({ projectId, milestoneId: ms.id, archived: 'include' })
      for (const t of m.tasks) {
        if (existingTasks.some((x) => x.title.trim().toLowerCase() === t.title.trim().toLowerCase())) continue
        createTask({ projectId, milestoneId: ms.id, title: t.title, description: t.description, acceptance: t.acceptance, role: t.role ?? null, priority: t.priority, status: t.status, createdBy: actor })
      }
    }
  })
  tx()
  bus.invalidate('milestones', 'tasks')
}

const STATUS_BOX: Record<TaskStatus, string> = {
  backlog: ' ', todo: ' ', in_progress: '~', ai_review: '~', human_review: '?', done: 'x', wont_do: '-', blocked: '!',
}

export function renderProgressMarkdown(projectId: string): string {
  const p = getProject(projectId)!
  const ms = listMilestones(projectId)
  const tasks = listTasks({ projectId }).filter((t) => t.status !== 'wont_do')
  const done = tasks.filter((t) => t.status === 'done').length
  const lines = [
    `# ${p.name} — Progress`,
    '',
    `> Generated by Helm · ${new Date().toISOString().slice(0, 10)} · ${done}/${tasks.length} tasks done`,
    '',
    `**Goal:** ${p.goal || '_not set_'}`,
    '',
  ]
  if (p.brief) lines.push(p.brief.trim(), '')
  const section = (title: string, status: string, desc: string, list: Task[]) => {
    const d = list.filter((t) => t.status === 'done').length
    lines.push(`## ${title}${status ? ` · _${status}_` : ''} (${d}/${list.length})`, '')
    if (desc) lines.push(desc.trim(), '')
    for (const t of list) lines.push(`- [${STATUS_BOX[t.status]}] ${t.title}${t.status !== 'done' && t.status !== 'todo' ? ` — ${TASK_STATUS_LABELS[t.status]}` : ''}`)
    lines.push('')
  }
  for (const m of ms) section(m.title, m.status, m.description, tasks.filter((t) => t.milestoneId === m.id))
  const loose = tasks.filter((t) => !t.milestoneId)
  if (loose.length) section('Unsorted', '', '', loose)
  lines.push('Legend: `[ ]` todo · `[~]` in progress / AI review · `[?]` awaiting human review · `[x]` done · `[!]` blocked', '')
  return lines.join('\n')
}

export function writeProgressFile(projectId: string) {
  const p = getProject(projectId)!
  const dir = join(p.path, 'docs', 'plan')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'PROGRESS.md')
  writeFileSync(file, renderProgressMarkdown(projectId))
  return file
}

/** Parse a markdown plan: `## Milestone` headings with `- [ ] task` bullets (indented lines become description). */
export function parsePlanMarkdown(md: string): PlanDraft {
  const plan: PlanDraft = { milestones: [] }
  let cur: PlanDraft['milestones'][number] | null = null
  let lastTask: PlanDraft['milestones'][number]['tasks'][number] | null = null
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const goal = line.match(/^\*\*Goal:\*\*\s*(.+)$/i) || line.match(/^Goal:\s*(.+)$/i)
    if (goal && !plan.goal) plan.goal = goal[1].trim()
    const h = line.match(/^##\s+(?:Milestone\s*\d*[:.-]?\s*)?(.+?)(?:\s+·.*)?(?:\s*\(\d+\/\d+\))?$/)
    if (h) {
      cur = { title: h[1].trim(), tasks: [] }
      plan.milestones.push(cur)
      lastTask = null
      continue
    }
    const t = line.match(/^[-*]\s+\[([ x~?!-])\]\s+(.+?)(?:\s+—\s+.+)?$/i)
    if (t) {
      if (!cur) plan.milestones.push((cur = { title: 'Unsorted', tasks: [] }))
      const s = t[1].toLowerCase()
      lastTask = { title: t[2].trim(), status: s === 'x' ? 'done' : s === '-' ? 'wont_do' : s === '~' ? 'in_progress' : s === '!' ? 'blocked' : s === '?' ? 'human_review' : 'todo' }
      cur.tasks.push(lastTask)
      continue
    }
    if (lastTask && /^\s{2,}\S/.test(line)) lastTask.description = ((lastTask.description || '') + '\n' + line.trim()).trim()
  }
  return plan
}

export function importPlanFile(projectId: string, relPath = 'docs/plan/PLAN.md') {
  const p = getProject(projectId)!
  const file = join(p.path, relPath)
  if (!existsSync(file)) throw new Error(`No plan file at ${relPath}`)
  const plan = parsePlanMarkdown(readFileSync(file, 'utf8'))
  applyPlan(projectId, plan)
  return plan
}
