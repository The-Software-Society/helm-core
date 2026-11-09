import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { Project, ProjectKind, ProjectStats } from '@shared/types'
import { db } from '../db'
import { toProject } from '../db/mappers'
import { bus } from '../bus'
import { DAY, id, now } from '../util'
import { HOME, canonicalPath } from '../paths'

const PALETTE = ['#8643FF', '#3520F4', '#6519EF', '#15E5A6', '#cdbcff', '#F4B740', '#FF7A9A', '#4FC3F7', '#9BE15D']

export function listProjects(includeArchived = false): Project[] {
  const rows = db
    .prepare(
      `SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived = 0'}
       ORDER BY pinned DESC, COALESCE(last_opened_at, last_activity_at, created_at) DESC`,
    )
    .all()
  return rows.map(toProject)
}

export function getProject(pid: string): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid)
  return r ? toProject(r) : null
}

export function projectByPath(path: string): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE path = ?').get(path)
  return r ? toProject(r) : listProjects(true).find((p) => canonicalPath(p.path) === canonicalPath(path)) || null
}

/** Longest project path that contains `path` (sessions in subdirs/worktrees map back to their project). */
export function projectForPath(path: string): Project | null {
  const canonical = canonicalPath(path)
  return listProjects(true).map((p) => ({ project: p, path: canonicalPath(p.path) }))
    .filter((p) => canonical === p.path || canonical.startsWith(p.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0]?.project || null
}

export function guessKind(path: string): ProjectKind {
  const p = path.toLowerCase()
  if (p.includes('/clients/') || p.includes('/sites/')) return 'client'
  if (p.includes('/helm')) return 'internal'
  return 'other'
}

function prettyName(path: string) {
  const b = basename(path)
  return b
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function createProject(input: { path: string; name?: string; kind?: ProjectKind; goal?: string }): Project {
  input = { ...input, path: canonicalPath(input.path) }
  const existing = projectByPath(input.path)
  if (existing) {
    if (existing.archived) updateProject(existing.id, { archived: false })
    return getProject(existing.id)!
  }
  if (!existsSync(input.path) || !statSync(input.path).isDirectory()) throw new Error(`Not a directory: ${input.path}`)
  const count = (db.prepare('SELECT count(*) c FROM projects').get() as { c: number }).c
  const p = {
    id: id('prj'),
    name: input.name || prettyName(input.path),
    path: input.path,
    kind: input.kind || guessKind(input.path),
    color: PALETTE[count % PALETTE.length],
    goal: input.goal || '',
    t: now(),
  }
  db.prepare(
    `INSERT INTO projects(id, name, path, kind, color, goal, last_opened_at, last_activity_at, created_at)
     VALUES(@id, @name, @path, @kind, @color, @goal, @t, NULL, @t)`,
  ).run(p)
  // backfill activity from any indexed transcripts
  const last = db.prepare(`SELECT max(updated_at) m FROM transcripts WHERE project_path = ? OR project_path LIKE ? || '/%'`).get(p.path, p.path) as { m: number | null }
  db.prepare('UPDATE projects SET last_activity_at = ? WHERE id = ?').run(last?.m || p.t, p.id)
  const project = getProject(p.id)!
  bus.emitEvent({ t: 'project.update', project })
  return project
}

const PROJECT_FIELDS: Record<string, string> = {
  name: 'name', kind: 'kind', color: 'color', goal: 'goal', brief: 'brief',
  pinned: 'pinned', archived: 'archived', lastOpenedAt: 'last_opened_at',
}

export function updateProject(pid: string, patch: Partial<Project>): Project {
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    const col = PROJECT_FIELDS[k]
    if (!col) continue
    sets.push(`${col} = ?`)
    vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v)
  }
  if (sets.length) db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, pid)
  const project = getProject(pid)!
  bus.emitEvent({ t: 'project.update', project })
  return project
}

export function deleteProject(pid: string) {
  db.prepare('DELETE FROM projects WHERE id = ?').run(pid)
  bus.invalidate('projects')
}

export function touchProject(pid: string, at = now()) {
  const r = db.prepare('UPDATE projects SET last_activity_at = ? WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)').run(at, pid, at)
  if (r.changes) {
    const project = getProject(pid)
    if (project) bus.emitEvent({ t: 'project.update', project })
  }
}

export function markOpened(pid: string) {
  return updateProject(pid, { lastOpenedAt: now() })
}

/** Recently worked-on folders from Claude/Codex history that aren't projects yet. */
export function suggestProjects(limit = 12) {
  const rows = db
    .prepare(
      `SELECT project_path path, max(updated_at) last, count(*) sessions, sum(message_count) messages
       FROM transcripts GROUP BY project_path ORDER BY last DESC LIMIT 200`,
    )
    .all() as { path: string; last: number; sessions: number; messages: number }[]
  const existing = new Set(listProjects(true).map((p) => p.path))
  const skip = new Set([HOME, `${HOME}/Developer`, `${HOME}/Documents`, `${HOME}/Downloads`, `${HOME}/Desktop`, '/'])
  const out: { path: string; name: string; kind: ProjectKind; last: number; sessions: number; messages: number }[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (skip.has(r.path) || existing.has(r.path) || seen.has(r.path)) continue
    if (r.path.includes('/Documents/Codex/') || r.path.startsWith('/private/') || r.path.includes('/.helm/worktrees/')) continue
    if (!existsSync(r.path)) continue
    // collapse subfolders into a parent already suggested
    if ([...seen].some((s) => r.path.startsWith(s + '/'))) continue
    seen.add(r.path)
    out.push({ ...r, name: prettyName(r.path), kind: guessKind(r.path) })
    if (out.length >= limit) break
  }
  return out
}

export function projectStats(pid: string): ProjectStats {
  const counts = db
    .prepare(
      `SELECT count(*) total, sum(status='done') done, sum(status IN ('ai_review','human_review')) review
       FROM tasks WHERE project_id = ? AND status NOT IN ('backlog','wont_do') AND archived_at IS NULL`,
    )
    .get(pid) as { total: number; done: number | null; review: number | null }
  const sess = db
    .prepare(
      `SELECT sum(status NOT IN ('exited','error')) active, sum(status IN ('waiting','done') AND seen = 0) waiting
       FROM sessions WHERE project_id = ? AND archived = 0`,
    )
    .get(pid) as { active: number | null; waiting: number | null }
  const ms = db
    .prepare(`SELECT id, title FROM milestones WHERE project_id = ? AND status != 'done' ORDER BY (status='active') DESC, ord LIMIT 1`)
    .get(pid) as { id: string; title: string } | undefined
  const next = db
    .prepare(
      `SELECT t.id, t.title, t.status FROM tasks t LEFT JOIN milestones m ON m.id = t.milestone_id
       WHERE t.project_id = ? AND t.status IN ('in_progress','todo','blocked') AND t.archived_at IS NULL
       ORDER BY (t.status='in_progress') DESC, (m.status='active') DESC, COALESCE(m.ord, 999), t.priority, t.ord LIMIT 1`,
    )
    .get(pid) as ProjectStats['nextTask'] | undefined
  const p = getProject(pid)
  const last = p?.lastActivityAt ?? null
  const hasOpenWork = (counts.total || 0) - (counts.done || 0) > 0 || !!ms
  return {
    projectId: pid,
    tasksTotal: counts.total || 0,
    tasksDone: counts.done || 0,
    inReview: counts.review || 0,
    activeSessions: sess.active || 0,
    waitingSessions: sess.waiting || 0,
    nextTask: next ?? null,
    activeMilestone: ms ?? null,
    lastActivityAt: last,
    staleDays: last && hasOpenWork ? Math.floor((now() - last) / DAY) : null,
  }
}
