import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { RoleId, TaskStatus } from '@shared/types'
import { EVIDENCE_DIR } from '../paths'
import { id, now } from '../util'
import { db } from '../db'
import { getProject, listProjects, projectStats } from '../services/projects'
import { addEvidence, addTaskEvent, archiveTask, closeTask, createTask, findOpenTask, getTask, listEvidence, listMilestones, listTasks, taskEvents, updateTask } from '../services/tasks'
import { runAiReview, reviewRunning } from '../services/review'
import { createSession, getSession, listSessions, snapshot, write } from '../pty/manager'
import { TOOLS } from './tools'
import { saveHandoff } from '../services/recovery'

export function mcpContext(sessionId: string) {
  const s = sessionId ? getSession(sessionId) : null
  return { sessionId, orchestrator: s?.kind === 'orchestrator' }
}

function requireSession(sid: string) {
  const s = getSession(sid)
  if (!s) throw new Error('This terminal was not started by Helm (no HELM_SESSION_ID).')
  return s
}

function resolveTask(sid: string, taskId?: string) {
  const tid = taskId || requireSession(sid).taskId
  if (!tid) throw new Error('No taskId given and this session has no assigned task. Use helm_task_list / helm_task_create.')
  const t = getTask(tid)
  if (!t) throw new Error(`Unknown task ${tid}`)
  const s = requireSession(sid)
  if (t.projectId !== s.projectId && s.kind !== 'orchestrator') throw new Error('Task belongs to another project')
  return t
}

function screenText(sid: string, lines: number) {
  // Serialized screen contains ANSI; strip for model consumption.
  const raw = snapshot(sid)
  // eslint-disable-next-line no-control-regex
  const plain = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '')
  return plain.split('\n').filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim())).slice(-lines).join('\n')
}

export async function callTool(name: string, sid: string, a: any): Promise<unknown> {
  const caller = requireSession(sid)
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`Unknown tool ${name}`)
  if (tool.orchestratorOnly && caller.kind !== 'orchestrator') throw new Error('This tool requires a Pilot session')
  switch (name) {
    case 'helm_checkpoint':
      saveHandoff(sid, a.note)
      return 'Handoff saved for this session. Continue updating task progress and evidence as usual.'
    case 'helm_whoami': {
      const s = requireSession(sid)
      const p = getProject(s.projectId)!
      const ms = listMilestones(p.id).find((m) => m.status === 'active')
      const t = s.taskId ? getTask(s.taskId) : null
      return {
        session: { id: s.id, name: s.name, role: s.role, provider: s.provider, model: s.model, worktree: s.worktree, branch: s.branch },
        project: { id: p.id, name: p.name, path: p.path, goal: p.goal, brief: p.brief, activeMilestone: ms?.title ?? null },
        task: t ? { id: t.id, title: t.title, status: t.status, description: t.description, acceptance: t.acceptance } : null,
      }
    }
    case 'helm_task_list': {
      const s = requireSession(sid)
      const status = a.status ? (String(a.status).split(',').map((x) => x.trim()) as TaskStatus[]) : undefined
      const ms = new Map(listMilestones(s.projectId).map((m) => [m.id, m.title]))
      return listTasks({ projectId: s.projectId, status }).map((t) => ({
        id: t.id, title: t.title, status: t.status, milestone: t.milestoneId ? ms.get(t.milestoneId) : null, role: t.role,
      }))
    }
    case 'helm_task_get': {
      const t = resolveTask(sid, a.taskId)
      return { ...t, activity: taskEvents(t.id).slice(-20), evidence: listEvidence(t.id) }
    }
    case 'helm_task_create': {
      const s = requireSession(sid)
      // No default milestone: defaulting to the active one filed every session's work under it.
      const all = listMilestones(s.projectId)
      const ms = a.milestone ? all.find((m) => m.id === a.milestone || m.title.toLowerCase() === String(a.milestone).toLowerCase()) : undefined
      if (a.milestone && !ms) throw new Error(`No milestone "${a.milestone}". Milestones: ${all.map((m) => m.title).join('; ') || 'none'}`)
      const existing = findOpenTask(s.projectId, a.title || '')
      if (existing) return { existing: existing.id, status: existing.status, note: 'An open task with this title already exists; post progress on it instead of creating another.' }
      const t = createTask({
        projectId: s.projectId, milestoneId: ms?.id ?? null, title: a.title, description: a.description, acceptance: a.acceptance,
        role: (a.role as RoleId) || null, createdBy: sid,
      })
      return { created: t.id, milestone: ms?.title ?? null }
    }
    case 'helm_task_progress': {
      const t = resolveTask(sid, a.taskId)
      addTaskEvent(t.id, 'progress', sid, a.note)
      if (a.blocked) updateTask(t.id, { status: 'blocked' }, sid)
      else if (t.status === 'todo' || t.status === 'blocked') updateTask(t.id, { status: 'in_progress' }, sid)
      return 'noted'
    }
    case 'helm_task_close':
    case 'helm_task_archive': {
      if (!a.taskId) throw new Error('taskId is required')
      if (!a.reason?.trim()) throw new Error('Give a reason')
      const t = resolveTask(sid, a.taskId)
      const own = t.createdBy === sid || caller.kind === 'orchestrator'
      if (name === 'helm_task_archive') {
        if (!own) throw new Error('Sessions archive only tasks they created; ask the user to archive this one')
        archiveTask(t.id, a.reason, sid)
        return `Archived ${t.id}. The user can restore it.`
      }
      if (a.outcome !== 'done' && a.outcome !== 'wont_do') throw new Error('outcome must be done or wont_do')
      if (!own && !(a.outcome === 'wont_do' && t.id === caller.taskId)) throw new Error('Sessions close only tasks they created (or mark their assigned task wont_do); ask the user to close this one')
      if (a.outcome === 'done' && (t.status === 'ai_review' || t.status === 'human_review')) throw new Error('This task is waiting on review; the user approves it')
      closeTask(t.id, a.outcome, a.reason, sid)
      return `Closed ${t.id} as ${a.outcome}.`
    }
    case 'helm_attach_evidence': {
      const t = resolveTask(sid, a.taskId)
      let path: string | null = null
      if (a.path) {
        if (!existsSync(a.path)) throw new Error(`File not found: ${a.path}`)
        const dir = join(EVIDENCE_DIR, t.id)
        mkdirSync(dir, { recursive: true })
        path = join(dir, `${id('f')}${extname(a.path) || ''}`)
        copyFileSync(a.path, path)
      }
      const e = addEvidence({ taskId: t.id, sessionId: sid || null, kind: a.kind, title: a.title || basename(a.path || '') || a.kind, path, body: a.body || '' })
      return { attached: e.id }
    }
    case 'helm_submit_for_review': {
      const t = resolveTask(sid, a.taskId)
      if (reviewRunning(t.id)) throw new Error('AI review is already running')
      if (!listEvidence(t.id).length) throw new Error('Attach verification evidence before submitting for review')
      addTaskEvent(t.id, 'comment', sid, `Submitted for review:\n${a.summary}`)
      updateTask(t.id, { status: 'ai_review' }, sid)
      void runAiReview(t.id)
      return 'Submitted. Helm is running an independent AI review; if it passes, the user reviews next. You may stop here.'
    }
    // ---- orchestrator ----
    case 'helm_projects':
      return listProjects().map((p) => ({ id: p.id, name: p.name, kind: p.kind, goal: p.goal, ...projectStats(p.id) }))
    case 'helm_sessions':
      return listSessions({ projectId: a.projectId })
        .filter((s) => s.id !== sid && s.status !== 'exited' && s.status !== 'error')
        .map((s) => ({ id: s.id, project: getProject(s.projectId)?.name, name: s.name, provider: s.provider, model: s.model, role: s.role, status: s.status, detail: s.statusDetail, taskId: s.taskId }))
    case 'helm_session_read':
      return screenText(a.sessionId, a.lines || 80)
    case 'helm_session_send': {
      const target = getSession(a.sessionId)
      if (!target) throw new Error('Unknown session')
      write(a.sessionId, a.text)
      if (a.enter !== false) setTimeout(() => write(a.sessionId, '\r'), 120)
      addLog(sid, `→ ${target.name}: ${a.text}`)
      return 'sent'
    }
    case 'helm_session_start': {
      const s = createSession({ projectId: a.projectId, role: a.role, prompt: a.prompt, taskId: a.taskId, worktree: !!a.worktree })
      addLog(sid, `started ${s.name} (${s.provider}/${s.model}) in ${getProject(s.projectId)?.name}`)
      return { sessionId: s.id, name: s.name, provider: s.provider, model: s.model }
    }
  }
  throw new Error(`Unknown tool ${name}`)
}

/** Audit trail of what the orchestrator did on the user's behalf (shown in the session's activity panel). */
function addLog(sid: string, line: string) {
  db.prepare('INSERT INTO session_events(session_id, event, payload, created_at) VALUES(?, ?, ?, ?)').run(sid, 'orchestrator:action', JSON.stringify({ line }), now())
}
