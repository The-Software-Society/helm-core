import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import type { NeedsYouItem, RoleConfig } from '@shared/types'
import { get, post, patch, del, HttpError } from './server'
import { db, getSetting, setSetting } from './db'
import { DAY, now } from './util'
import * as projects from './services/projects'
import * as tasks from './services/tasks'
import * as models from './services/models'
import * as ai from './services/ai'
import { humanVerdict, relayToSession, runAiReview, reviewRunning } from './services/review'
import * as pty from './pty/manager'
import * as tx from './transcripts/indexer'
import { listProviders } from './providers'
import { headlessActive } from './llm/runner'
import { mcpContext, callTool } from './mcp/api'
import { handleHook } from './hooks'
import { saveUserEdit } from './userEdits'
import { shellEnv } from './env'
import { DATA_DIR } from './paths'
import { recoveryContext } from './services/recovery'

const need = <T>(v: T | null | undefined, what = 'Not found'): T => {
  if (v === null || v === undefined) throw new HttpError(404, what)
  return v
}

export function registerCoreRoutes() {
  get('/sessions/:id/recovery', ({ params }) => ({ context: recoveryContext(params.id) }))
  post('/workspace/checkpoint', () => { pty.checkpointAll(); return { ok: true, at: now() } })
  post('/workspace/resume', () => {
    const results: { id: string; error?: string }[] = []
    for (const s of pty.listSessions().filter((s) => s.recoveryPending && !projects.getProject(s.projectId)?.archived)) {
      try { pty.restart(s.id); results.push({ id: s.id }) }
      catch (e) { results.push({ id: s.id, error: String(e) }) }
    }
    return results
  })
  // ---------- meta ----------
  get('/status', () => ({
    pid: process.pid,
    live: pty.liveCount(),
    headless: headlessActive(),
    index: tx.indexState,
    providers: listProviders(),
    dataDir: DATA_DIR,
  }))

  get('/settings', () =>
    Object.fromEntries(
      (db.prepare(`SELECT key, value FROM settings WHERE key NOT LIKE 'daemon.%' AND key NOT LIKE 'catchup:%'`).all() as any[]).map((r) => [r.key, JSON.parse(r.value)]),
    ),
  )
  post('/settings', ({ body }) => {
    for (const [k, v] of Object.entries(body || {})) if (!k.startsWith('daemon.')) setSetting(k, v)
    return { ok: true }
  })

  // ---------- projects ----------
  get('/projects', ({ query }) => projects.listProjects(query.get('archived') === '1'))
  get('/projects/suggestions', () => projects.suggestProjects(14))
  post('/projects', ({ body }) => projects.createProject(body))
  get('/projects/:id', ({ params }) => need(projects.getProject(params.id)))
  patch('/projects/:id', ({ params, body }) => projects.updateProject(params.id, body))
  del('/projects/:id', ({ params }) => (projects.deleteProject(params.id), { ok: true }))
  post('/projects/:id/opened', ({ params }) => projects.markOpened(params.id))
  get('/projects/:id/stats', ({ params }) => projects.projectStats(params.id))
  get('/stats', () => projects.listProjects().map((p) => projects.projectStats(p.id)))
  get('/projects/:id/git', ({ params }) => gitInfo(need(projects.getProject(params.id)).path))
  post('/projects/:id/reveal', ({ params, body }) => {
    const p = need(projects.getProject(params.id))
    const app = body?.app as string | undefined
    execFile('open', app ? ['-a', app, p.path] : [p.path])
    return { ok: true }
  })
  post('/projects/:id/catchup', async ({ params }) => ai.catchUp(params.id))
  get('/projects/:id/catchup', ({ params }) => ai.lastCatchUp(params.id))
  post('/projects/:id/plan/draft', async ({ params, body }) => ai.draftPlan(params.id, body?.guidance || ''))
  post('/projects/:id/plan/apply', ({ params, body }) => (tasks.applyPlan(params.id, body), { ok: true }))
  post('/projects/:id/plan/import', ({ params, body }) => tasks.importPlanFile(params.id, body?.path))
  post('/projects/:id/plan/export', ({ params }) => ({ file: tasks.writeProgressFile(params.id) }))
  get('/projects/:id/plan/markdown', ({ params }) => ({ markdown: tasks.renderProgressMarkdown(params.id) }))
  get('/projects/:id/plan/file', ({ params }) => {
    const p = need(projects.getProject(params.id))
    for (const rel of ['docs/plan/PLAN.md', 'PLAN.md', 'docs/PLAN.md', 'ROADMAP.md']) {
      const f = join(p.path, rel)
      if (existsSync(f)) return { path: rel, content: readFileSync(f, 'utf8') }
    }
    return null
  })

  // ---------- milestones & tasks ----------
  get('/projects/:id/milestones', ({ params }) => tasks.listMilestones(params.id))
  post('/milestones', ({ body }) => tasks.createMilestone(body))
  patch('/milestones/:id', ({ params, body }) => tasks.updateMilestone(params.id, body))
  del('/milestones/:id', ({ params }) => (tasks.deleteMilestone(params.id), { ok: true }))

  get('/tasks', ({ query }) =>
    tasks.listTasks({ projectId: query.get('projectId') || undefined, status: (query.get('status')?.split(',') as any) || undefined, archived: (query.get('archived') as any) || undefined }),
  )
  post('/tasks', ({ body }) => tasks.createTask(body))
  get('/tasks/:id', ({ params }) => {
    const t = need(tasks.getTask(params.id))
    return { task: t, events: tasks.taskEvents(t.id), evidence: tasks.listEvidence(t.id), session: t.sessionId ? pty.getSession(t.sessionId) : null }
  })
  patch('/tasks/:id', ({ params, body }) => tasks.updateTask(params.id, body))
  del('/tasks/:id', ({ params }) => (tasks.deleteTask(params.id), { ok: true }))
  post('/tasks/:id/close', ({ params, body }) => tasks.closeTask(need(tasks.getTask(params.id)).id, body?.outcome, body?.reason || ''))
  post('/tasks/:id/archive', ({ params, body }) => tasks.archiveTask(need(tasks.getTask(params.id)).id, body?.reason || ''))
  post('/tasks/:id/restore', ({ params }) => tasks.restoreTask(need(tasks.getTask(params.id)).id))
  post('/tasks/:id/comment', ({ params, body }) => tasks.addTaskEvent(params.id, 'comment', 'user', body.text))
  post('/tasks/:id/review', ({ params, body }) => humanVerdict(params.id, body.verdict, body.notes || ''))
  post('/tasks/:id/ai-review', ({ params }) => {
    if (reviewRunning(params.id)) throw new HttpError(409, 'AI review is already running')
    if (!tasks.listEvidence(params.id).length) throw new HttpError(400, 'Attach verification evidence before running AI review')
    tasks.updateTask(params.id, { status: 'ai_review' })
    void runAiReview(params.id)
    return { ok: true }
  })
  post('/tasks/:id/relay', ({ params, body }) => ({ delivered: relayToSession(params.id, body.text) }))
  post('/tasks/:id/start', ({ params, body }) => {
    const t = need(tasks.getTask(params.id))
    const role = body?.role || t.role || 'implement'
    const prompt =
      body?.prompt ||
      `Work on this task: ${t.title}. Start by calling helm_whoami to load full context, then plan briefly and execute. Verify your work, attach evidence, then call helm_submit_for_review.`
    return pty.createSession({ projectId: t.projectId, taskId: t.id, role, provider: body?.provider, model: body?.model, effort: body?.effort, prompt, worktree: body?.worktree })
  })
  get('/reviews', () => tasks.reviewQueue())

  // ---------- sessions ----------
  get('/sessions', ({ query }) => pty.listSessions({ projectId: query.get('projectId') || undefined, includeArchived: query.get('archived') === '1' }))
  post('/sessions', ({ body }) => pty.createSession(body))
  get('/sessions/:id', ({ params }) => need(pty.getSession(params.id)))
  get('/sessions/:id/conversation', async ({ params }) => {
    const session = need(pty.getSession(params.id))
    return { messages: session.provider === 'codex' && session.agentSessionId ? await tx.codexConversation(session.agentSessionId) : [] }
  })
  patch('/sessions/:id', ({ params, body }) => {
    const changes: Partial<import('@shared/types').Session> = {}
    if ('name' in body) changes.name = body.name
    if ('taskId' in body) changes.taskId = body.taskId
    if ('sidebarLabel' in body) {
      if (typeof body.sidebarLabel !== 'string' || body.sidebarLabel.trim().length > 64) throw new HttpError(400, 'Sidebar label must be 64 characters or fewer')
      changes.sidebarLabel = body.sidebarLabel.trim()
    }
    return pty.patchSession(params.id, changes)
  })
  post('/sessions/:id/kill', ({ params }) => (pty.kill(params.id), { ok: true }))
  post('/sessions/:id/restart', ({ params, body }) => pty.restart(params.id, body?.resume !== false))
  post('/sessions/:id/archive', ({ params }) => (pty.archive(params.id), { ok: true }))
  post('/sessions/:id/seen', ({ params }) => (pty.markSeen(params.id), { ok: true }))
  get('/sessions/:id/worktree', ({ params }) => pty.worktreeStatus(params.id))
  post('/sessions/:id/worktree/merge', ({ params }) => pty.mergeWorktree(params.id))
  post('/sessions/:id/worktree/remove', ({ params, body }) => (pty.removeWorktree(params.id, !!body?.deleteBranch), { ok: true }))
  get('/sessions/:id/events', ({ params }) =>
    (db.prepare('SELECT event, payload, created_at FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT 100').all(params.id) as any[]).map((r) => ({
      event: r.event,
      payload: safeJson(r.payload),
      at: r.created_at,
    })),
  )

  // ---------- transcripts / history ----------
  get('/transcripts', ({ query }) => tx.listTranscripts({ projectPath: query.get('projectPath') || undefined, limit: Number(query.get('limit')) || 100 }))
  get('/transcripts/search', ({ query }) => tx.searchTranscripts(query.get('q') || '', query.get('projectPath') || undefined))
  get('/transcripts/:id', ({ params }) => ({ transcript: need(tx.getTranscript(params.id)), messages: tx.transcriptMessages(params.id) }))
  post('/transcripts/:id/resume', ({ params, body }) => {
    const t = need(tx.getTranscript(params.id))
    const project = projects.projectForPath(t.projectPath) || need(projects.getProject(body?.projectId), 'Open the project first')
    return pty.resumeTranscript({ projectId: project.id, provider: t.source, agentSessionId: t.agentSessionId, name: t.title || 'Resumed', cwd: t.projectPath })
  })
  post('/transcripts/rescan', () => (void tx.scanAll(), { ok: true }))
  get('/usage', ({ query }) => tx.usageByDay(Number(query.get('days')) || 30))

  // ---------- models & roles ----------
  get('/providers', () => listProviders())
  get('/models', () => models.listModels())
  post('/models', ({ body }) => (models.addCustomModel(body), { ok: true }))
  post('/models/refresh', () => (models.refreshModels(), models.listModels()))
  get('/roles', () => models.listRoles())
  post('/roles', ({ body }) => {
    for (const r of body as RoleConfig[]) models.setRole(r)
    return models.listRoles()
  })

  // ---------- needs you ----------
  get('/needs-you', () => needsYou())

  // ---------- agent callbacks ----------
  post('/hooks/:provider/:sid', ({ params, query, body }) => {
    return handleHook(params.provider, params.sid, query.get('event') || '', typeof body === 'string' ? safeJson(body) : body)
  })
  post('/files/user-edit', ({ body }) => saveUserEdit(body || {}))
  get('/mcp-api/context', ({ sessionId }) => mcpContext(sessionId))
  post('/mcp-api/call/:tool', ({ params, body, sessionId }) => callTool(params.tool, sessionId, body || {}))
}

function safeJson(s: string) {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

function gitInfo(path: string) {
  const run = (...a: string[]) => {
    try {
      return execFileSync('git', ['-C', path, ...a], { encoding: 'utf8', env: shellEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }
  const branch = run('rev-parse', '--abbrev-ref', 'HEAD')
  if (!branch) return null
  return {
    branch,
    dirty: run('status', '--porcelain').split('\n').filter(Boolean).length,
    lastCommit: run('log', '-1', '--pretty=%s'),
    lastCommitAt: Number(run('log', '-1', '--pretty=%ct')) * 1000 || null,
    remote: run('remote', 'get-url', 'origin'),
  }
}

export function needsYou(): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  for (const s of pty.listSessions()) {
    if ((s.status === 'waiting' || s.status === 'done') && !s.seen)
      items.push({
        kind: 'session',
        id: s.id,
        projectId: s.projectId,
        title: s.name,
        detail: s.statusDetail || (s.status === 'waiting' ? 'Needs your input' : 'Finished'),
        at: s.lastActivityAt,
      })
  }
  for (const t of tasks.reviewQueue().filter((t) => t.status === 'human_review' || t.reviewError))
    items.push({ kind: 'review', id: t.id, projectId: t.projectId, title: t.title, detail: t.reviewError ? 'AI review needs attention' : 'Ready for your review', at: t.updatedAt })
  const staleAfter = getSetting<number>('nudge.staleDays', 14)
  for (const p of projects.listProjects()) {
    const st = projects.projectStats(p.id)
    if (st.staleDays !== null && st.staleDays >= staleAfter && (p.kind === 'passion' || p.pinned))
      items.push({
        kind: 'stale',
        id: p.id,
        projectId: p.id,
        title: p.name,
        detail: st.nextTask ? `Untouched ${st.staleDays}d · next: ${st.nextTask.title}` : `Untouched ${st.staleDays}d`,
        at: p.lastActivityAt || now() - st.staleDays * DAY,
      })
  }
  return items.sort((a, b) => b.at - a.at)
}
