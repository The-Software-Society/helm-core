import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ProviderId, RoleId, Session, SessionStatus } from '@shared/types'
import { db } from '../db'
import { toSession } from '../db/mappers'
import { bus } from '../bus'
import { id, log, now } from '../util'
import { buildLaunch } from '../providers'
import { getProject, touchProject } from '../services/projects'
import { getRole } from '../services/models'
import { getTask, updateTask, addTaskEvent } from '../services/tasks'
import { WORKTREE_DIR, RUNTIME_DIR, CLAUDE_PROJECTS, CODEX_HOME, QWEN_HOME } from '../paths'
import { shellEnv } from '../env'
import { recoveryContext, HANDOFF_INSTRUCTIONS } from '../services/recovery'
import { HOST_LOST, adoptTerminal, connect as connectHost, detachHost, disableHost, discardTerminal, releaseTerminal, spawnTerminal, usingHost, type Proc } from '../ptyhost/client'

interface Live {
  proc: Proc
  mirror: Terminal
  serializer: SerializeAddon
  attached: number
  lastInputAt: number
  lastOutputAt: number
}

const live = new Map<string, Live>()
const SCROLLBACK = 5000

// ---------- persistence helpers ----------
export function getSession(sid: string): Session | null {
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid)
  return r ? toSession(r) : null
}

export function listSessions(filter: { projectId?: string; includeArchived?: boolean } = {}): Session[] {
  const where = [filter.includeArchived ? '1=1' : 'archived = 0']
  const vals: unknown[] = []
  if (filter.projectId) (where.push('project_id = ?'), vals.push(filter.projectId))
  return db
    .prepare(`SELECT * FROM sessions WHERE ${where.join(' AND ')} ORDER BY created_at`)
    .all(...vals)
    .map(toSession)
}

const SESSION_FIELDS: Record<string, string> = {
  name: 'name', sidebarLabel: 'sidebar_label', status: 'status', statusDetail: 'status_detail', seen: 'seen', agentSessionId: 'agent_session_id',
  pid: 'pid', cols: 'cols', rows: 'rows', lastActivityAt: 'last_activity_at', exitedAt: 'exited_at',
  recoveryPending: 'recovery_pending', checkpointAt: 'checkpoint_at', exitCode: 'exit_code', archived: 'archived', taskId: 'task_id', model: 'model', effort: 'effort',
}

export function patchSession(sid: string, patch: Partial<Session>, emit = true): Session | null {
  const keys = Object.keys(patch).filter((k) => SESSION_FIELDS[k])
  if (!keys.length) return getSession(sid)
  db.prepare(`UPDATE sessions SET ${keys.map((k) => `${SESSION_FIELDS[k]} = ?`).join(', ')} WHERE id = ?`).run(
    ...keys.map((k) => {
      const v = (patch as any)[k]
      return typeof v === 'boolean' ? (v ? 1 : 0) : v
    }),
    sid,
  )
  const s = getSession(sid)
  if (s && emit) bus.emitEvent({ t: 'session.update', session: s })
  return s
}

/** Central status transition. Attention states (waiting/done) flip `seen` off so the sidebar badges them. */
export function setStatus(sid: string, status: SessionStatus, detail = '') {
  const s = getSession(sid)
  if (!s) return
  if (s.status === status && s.statusDetail === detail) return
  if ((s.status === 'exited' || s.status === 'error') && status !== 'starting') return
  const attention = status === 'waiting' || status === 'done'
  patchSession(sid, {
    status,
    statusDetail: detail,
    lastActivityAt: now(),
    ...(attention ? { seen: false } : status === 'running' ? { seen: true } : {}),
  })
  touchProject(s.projectId)
}

// ---------- worktrees ----------
function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'work'
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: shellEnv() }).trim()
}

export function isGitRepo(path: string) {
  try {
    return git(path, 'rev-parse', '--is-inside-work-tree') === 'true'
  } catch {
    return false
  }
}

export function createWorktree(projectPath: string, name: string) {
  const branch = `helm/${slug(name)}-${Date.now().toString(36).slice(-4)}`
  const dir = join(WORKTREE_DIR, slug(basename(projectPath)), branch.replace('helm/', ''))
  mkdirSync(join(WORKTREE_DIR, slug(basename(projectPath))), { recursive: true })
  git(projectPath, 'worktree', 'add', '-b', branch, dir)
  return { dir, branch }
}

export function removeWorktree(sid: string, deleteBranch = false) {
  const s = getSession(sid)
  if (!s?.worktree) return
  const p = getProject(s.projectId)!
  try {
    git(p.path, 'worktree', 'remove', '--force', s.worktree)
    if (deleteBranch && s.branch) git(p.path, 'branch', '-D', s.branch)
  } catch (e) {
    log('worktree remove failed', e)
  }
}

export function worktreeStatus(sid: string) {
  const s = getSession(sid)
  if (!s?.worktree || !existsSync(s.worktree)) return null
  const p = getProject(s.projectId)!
  const base = git(p.path, 'rev-parse', '--abbrev-ref', 'HEAD')
  const ahead = Number(git(s.worktree, 'rev-list', '--count', `${base}..HEAD`) || 0)
  const dirty = git(s.worktree, 'status', '--porcelain').split('\n').filter(Boolean).length
  const stat = git(s.worktree, 'diff', '--shortstat', base)
  return { base, branch: s.branch, ahead, dirty, stat }
}

export function mergeWorktree(sid: string) {
  const s = getSession(sid)
  if (!s?.worktree || !s.branch) throw new Error('Session has no worktree')
  const p = getProject(s.projectId)!
  const dirty = git(s.worktree, 'status', '--porcelain')
  if (dirty) throw new Error('Worktree has uncommitted changes — ask the agent to commit first')
  git(p.path, 'merge', '--no-ff', s.branch, '-m', `Merge ${s.branch} (${s.name}) via Helm`)
  return worktreeStatus(sid)
}

// ---------- lifecycle ----------
export interface CreateSessionInput {
  projectId: string
  provider?: ProviderId
  role?: RoleId | null
  model?: string | null
  effort?: string | null
  name?: string
  prompt?: string
  taskId?: string | null
  worktree?: boolean
  cols?: number
  rows?: number
  orchestrator?: boolean
}

function sessionName(input: CreateSessionInput, provider: ProviderId) {
  if (input.name) return input.name
  if (input.taskId) return getTask(input.taskId)?.title.slice(0, 48) || 'Task'
  if (input.prompt) return input.prompt.replace(/\s+/g, ' ').slice(0, 48)
  const n = (db.prepare('SELECT count(*) c FROM sessions WHERE project_id = ? AND provider = ?').get(input.projectId, provider) as { c: number }).c
  const label = { claude: 'Claude', codex: 'Codex', qwen: 'Qwen', shell: 'Shell' }[provider]
  return `${label} ${n + 1}`
}

function taskContext(taskId: string, sessionId: string): string {
  const t = getTask(taskId)
  if (!t) return ''
  return [
    `You are working inside Helm (an agent hub) on task ${t.id}: "${t.title}".`,
    t.description ? `Task details:\n${t.description}` : '',
    t.acceptance ? `Acceptance criteria:\n${t.acceptance}` : '',
    `Helm MCP tools are available (server "helm"). As you work: call helm_task_progress with short milestone notes;`,
    `attach proof with helm_attach_evidence (screenshots saved to disk, test output, diff summaries);`,
    `when the work is complete AND verified, call helm_submit_for_review with a summary — the user does the final human review.`,
    `If blocked on a decision only the user can make, call helm_task_progress with blocked=true and ask in the terminal.`,
    `(Helm session ${sessionId})`,
  ]
    .filter(Boolean)
    .join('\n')
}

const PLAN_CONTEXT = [
  "You are running in Helm's Plan role on the most capable model. Your product is decisions, plans and well-specified tasks — not implementation.",
  'When the user picks items from options you presented, do not carry them out in this session. Create one Helm task per item with helm_task_create,',
  'choosing the role that fits (implement, bugfix, grunt, review, data) with a clear acceptance line, so each runs on the cheaper model routed to',
  'that role. Then tell the user which tasks you created and which role (and therefore model) each will use, and stop.',
  'Only do the work here if the user explicitly says to do it in this session.',
].join(' ')

const ORCHESTRATOR_CONTEXT = [
  "You are Helm's orchestrator: the user's master session overseeing every project and agent terminal.",
  'Use helm_projects and helm_sessions to see the fleet; helm_session_read to inspect a terminal; helm_session_send to answer',
  'an agent or redirect it; helm_session_start to launch work on tasks (routing picks the model per role).',
  'Operate within the user\'s standing preferences: lean on autonomy for routine decisions, but never approve anything destructive,',
  'production deploys, pushes to main, payments, or outbound client communication — escalate those to the user in this terminal.',
  'Keep a concise running log of decisions you make on his behalf so he can audit them when he returns.',
].join('\n')

export function createSession(input: CreateSessionInput): Session {
  const project = getProject(input.projectId)
  if (!project) throw new Error('Unknown project')
  if (input.taskId && getTask(input.taskId)?.projectId !== project.id) throw new Error('Task belongs to another project')
  const roleCfg = input.role ? getRole(input.role) : null
  const provider = input.provider || roleCfg?.provider || 'claude'
  const model = input.model !== undefined ? input.model : roleCfg && roleCfg.provider === provider ? roleCfg.model : null
  const effort = input.effort !== undefined ? input.effort : roleCfg && roleCfg.provider === provider ? roleCfg.effort : null
  const name = sessionName(input, provider)

  let cwd = project.path
  let worktree: string | null = null
  let branch: string | null = null
  if (input.worktree && provider !== 'shell' && isGitRepo(project.path)) {
    const wt = createWorktree(project.path, name)
    cwd = wt.dir
    worktree = wt.dir
    branch = wt.branch
  }

  const t = now()
  const row = {
    id: id('ses'), project_id: project.id, task_id: input.taskId ?? null, name, provider, model: model || null,
    effort: effort || null, role: input.role ?? null, cwd, worktree, branch, cols: input.cols || 120, rows: input.rows || 32, t,
    kind: input.orchestrator ? 'orchestrator' : 'agent',
  }
  db.prepare(
    `INSERT INTO sessions(id, project_id, task_id, name, provider, model, effort, role, cwd, worktree, branch, status, cols, rows, created_at, last_activity_at, kind)
     VALUES(@id, @project_id, @task_id, @name, @provider, @model, @effort, @role, @cwd, @worktree, @branch, 'starting', @cols, @rows, @t, @t, @kind)`,
  ).run(row)

  if (input.taskId) {
    const task = getTask(input.taskId)
    if (task && (task.status === 'todo' || task.status === 'backlog' || task.status === 'blocked')) updateTask(task.id, { status: 'in_progress', sessionId: row.id }, row.id)
    else if (task) updateTask(task.id, { sessionId: row.id }, row.id)
    addTaskEvent(input.taskId, 'assigned', 'user', `Assigned to ${name} (${provider}${model ? ` · ${model}` : ''})`)
  }
  try {
    db.prepare('UPDATE sessions SET base_commit = ? WHERE id = ?').run(git(cwd, 'rev-parse', 'HEAD'), row.id)
  } catch {}
  db.prepare('UPDATE sessions SET initial_prompt = ? WHERE id = ?').run(input.prompt || '', row.id)
  const systemContext = input.orchestrator ? ORCHESTRATOR_CONTEXT : input.taskId ? taskContext(input.taskId, row.id) : input.role === 'plan' ? PLAN_CONTEXT : undefined
  spawnSession(row.id, { prompt: input.prompt, systemContext: [systemContext, HANDOFF_INSTRUCTIONS].filter(Boolean).join('\n\n') })
  return getSession(row.id)!
}

/** Only resume when the agent actually has a saved conversation to load. */
export function hasConversation(s: Session): boolean {
  if (!s.agentSessionId) return false
  if (s.provider === 'claude') {
    try {
      return readdirSync(CLAUDE_PROJECTS).some((d) => existsSync(join(CLAUDE_PROJECTS, d, `${s.agentSessionId}.jsonl`)))
    } catch {
      return false
    }
  }
  if (s.provider === 'codex') {
    if (db.prepare('SELECT 1 FROM transcripts WHERE agent_session_id = ?').get(s.agentSessionId)) return true
    // A rebuild/reindex can temporarily empty SQLite while the conversation still exists on disk.
    try {
      return readdirSync(join(CODEX_HOME, 'sessions'), { recursive: true, encoding: 'utf8' }).some((file) => file.endsWith(`${s.agentSessionId}.jsonl`))
    } catch { return false }
  }
  if (s.provider === 'qwen') {
    try {
      // ~/.qwen/projects/<slug>/chats/<sessionId>.jsonl; the sibling .runtime.json is not a conversation.
      return readdirSync(join(QWEN_HOME, 'projects'), { recursive: true, encoding: 'utf8' }).some((file) => file.endsWith(`${s.agentSessionId}.jsonl`))
    } catch { return false }
  }
  return false
}

const SCREEN_DIR = join(RUNTIME_DIR, 'screens')
mkdirSync(SCREEN_DIR, { recursive: true })
function saveScreen(sid: string, data: string) {
  try {
    const target = join(SCREEN_DIR, `${sid}.ans`)
    writeFileSync(target + '.tmp', data, { mode: 0o600 })
    renameSync(target + '.tmp', target)
  } catch {}
}

function spawnSession(sid: string, opts: { prompt?: string; resume?: boolean; systemContext?: string } = {}) {
  try { spawnSessionProcess(sid, opts) }
  catch (e) {
    patchSession(sid, { status: 'error', statusDetail: e instanceof Error ? e.message : String(e), exitedAt: now(), pid: null })
    throw e
  }
}

function spawnSessionProcess(sid: string, opts: { prompt?: string; resume?: boolean; systemContext?: string }) {
  const session = getSession(sid)!
  if (opts.resume && !hasConversation(session)) opts = { ...opts, resume: false }
  bus.emitEvent({ t: 'pty.data', sessionId: sid, data: '\x1bc' }) // clear any attached view of the previous run
  const spec = buildLaunch({ session, ...opts })
  if (!existsSync(session.cwd)) throw new Error(`Working directory is missing: ${session.cwd}. Restore it before resuming.`)
  const proc = spawnTerminal(sid, spec.file, spec.args, { cols: session.cols, rows: session.rows, cwd: session.cwd, env: spec.env as Record<string, string> })
  log(`spawn ${sid} ${spec.file} ${spec.args.map((a) => (a.length > 80 ? a.slice(0, 80) + '…' : a)).join(' ')}`)
  wire(sid, proc, session.cols, session.rows)
  patchSession(sid, {
    pid: proc.pid || null,
    status: session.provider === 'shell' ? 'idle' : 'starting',
    statusDetail: '',
    exitCode: null,
    exitedAt: null,
    recoveryPending: false,
    agentSessionId: spec.agentSessionId,
  })
  // In the terminal host the pid arrives just after the spawn request.
  if (!proc.pid) setTimeout(() => proc.pid && live.get(sid)?.proc === proc && patchSession(sid, { pid: proc.pid }), 300)
}

/** Mirror a terminal's output and track its lifecycle, whether it was just started or reattached. */
function wire(sid: string, proc: Proc, cols: number, rows: number, screen = '') {
  const mirror = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
  const serializer = new SerializeAddon()
  mirror.loadAddon(serializer)
  if (screen) mirror.write(screen)
  mirror.parser.registerOscHandler(9, (message) => {
    handleNotification(sid, message)
    return true
  })
  const l: Live = { proc, mirror, serializer, attached: 0, lastInputAt: 0, lastOutputAt: now() }
  live.set(sid, l)

  let activityTimer: NodeJS.Timeout | null = null
  proc.onData((data) => {
    mirror.write(data)
    l.lastOutputAt = now()
    bus.emitEvent({ t: 'pty.data', sessionId: sid, data })
    if (!activityTimer)
      activityTimer = setTimeout(() => {
        activityTimer = null
        const s = getSession(sid)
        if (!s) return
        db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now(), sid)
        if (s.provider === 'shell') return
        // Prompts that appear before hooks can fire (folder trust, login) — surface them as "needs you".
        const blocker = detectBlockingPrompt(mirror)
        if (blocker && s.status !== 'waiting') return setStatus(sid, 'waiting', blocker)
        if (!blocker && s.status === 'waiting' && PRE_HOOK_DETAILS.has(s.statusDetail)) return setStatus(sid, 'running')
        // Agents without hook coverage: output shortly after user input means they're working.
        if (s.status === 'starting') setStatus(sid, 'running')
      }, 1000)
  })
  proc.onExit(({ exitCode }) => {
    if (live.get(sid)?.proc !== proc) return
    checkpointAll()
    live.delete(sid)
    if (activityTimer) clearTimeout(activityTimer)
    const s = getSession(sid)
    if (!s) return
    if (exitCode === HOST_LOST) patchSession(sid, { status: 'exited', statusDetail: 'Terminal host stopped — resume with saved context', recoveryPending: true, exitedAt: now(), pid: null })
    else patchSession(sid, { status: exitCode === 0 ? 'exited' : 'error', statusDetail: exitCode === 0 ? '' : `exit ${exitCode}`, exitCode, exitedAt: now(), pid: null, seen: exitCode === 0 })
    bus.emitEvent({ t: 'pty.exit', sessionId: sid, code: exitCode })
    // keep the final screen for viewing (and across daemon restarts)
    const screen = serializer.serialize()
    finalScreens.set(sid, screen)
    saveScreen(sid, screen)
    mirror.dispose()
  })
}

const finalScreens = new Map<string, string>()

const PRE_HOOK_PROMPTS: [RegExp, string][] = [
  [/trust this folder|trust the (contents|files)|do you trust/i, 'Trust this folder?'],
  [/select login method|log in to (claude|continue)|sign in with chatgpt/i, 'Login required'],
  [/allow .*mcp server|new mcp server found/i, 'Approve MCP server?'],
  [/update available!?[\s\S]*press enter to continue/i, 'CLI update available'],
  [/press enter to continue/i, 'Press enter to continue'],
]
const PRE_HOOK_DETAILS = new Set(PRE_HOOK_PROMPTS.map(([, d]) => d))

/** Scan the visible screen for interactive prompts that block before any hook fires. */
function detectBlockingPrompt(term: Terminal): string | null {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = Math.max(0, buf.baseY + buf.cursorY - 30); i <= buf.baseY + term.rows - 1; i++) lines.push(buf.getLine(i)?.translateToString(true) || '')
  const text = lines.join('\n')
  for (const [re, detail] of PRE_HOOK_PROMPTS) if (re.test(text)) return detail
  return null
}

/** Codex TUI notifications arrive as OSC 9 escapes: "Approval requested: …" or turn-complete text. */
function handleNotification(sid: string, message: string) {
  const s = getSession(sid)
  const msg = message.trim()
  if (!s || s.provider === 'shell' || !msg || /^\d+;/.test(msg)) return
  if (/^(approval requested|permission requested|input requested|question)/i.test(msg)) setStatus(sid, 'waiting', msg.slice(0, 160))
  else if (s.provider === 'codex') setStatus(sid, 'done', msg.slice(0, 160))
}

export function snapshot(sid: string): string {
  const l = live.get(sid)
  if (l) return l.serializer.serialize()
  const mem = finalScreens.get(sid)
  if (mem) return mem
  try {
    return readFileSync(join(SCREEN_DIR, `${sid}.ans`), 'utf8')
  } catch {
    return ''
  }
}

export function write(sid: string, data: string) {
  const l = live.get(sid)
  if (!l) return
  l.lastInputAt = now()
  l.proc.write(data)
  const s = getSession(sid)
  if (s && !s.seen) patchSession(sid, { seen: true })
  // Enter after waiting/done → agent resumes working.
  if (s && s.provider !== 'shell' && (s.status === 'waiting' || s.status === 'done') && /\r/.test(data)) setStatus(sid, 'running')
}

export function resize(sid: string, cols: number, rows: number) {
  const l = live.get(sid)
  if (!l || cols < 2 || rows < 2) return
  try {
    l.proc.resize(cols, rows)
    l.mirror.resize(cols, rows)
  } catch {}
  db.prepare('UPDATE sessions SET cols = ?, rows = ? WHERE id = ?').run(cols, rows, sid)
}

export function isLive(sid: string) {
  return live.has(sid)
}

export function kill(sid: string) {
  const l = live.get(sid)
  if (l) l.proc.kill()
}

export function restart(sid: string, resume = true) {
  const s = getSession(sid)
  if (!s) throw new Error('Unknown session')
  if (live.has(sid)) throw new Error('Session is still running')
  finalScreens.delete(sid)
  patchSession(sid, { status: 'starting', archived: false })
  const context = recoveryContext(sid)
  spawnSession(sid, { resume: resume && hasConversation(s), prompt: context, systemContext: [s.kind === 'orchestrator' ? ORCHESTRATOR_CONTEXT : s.taskId ? taskContext(s.taskId, sid) : s.role === 'plan' ? PLAN_CONTEXT : '', HANDOFF_INSTRUCTIONS].filter(Boolean).join('\n\n') })
  return getSession(sid)!
}

export function archive(sid: string) {
  kill(sid)
  patchSession(sid, { archived: true })
  bus.emitEvent({ t: 'session.remove', sessionId: sid })
}

export function markSeen(sid: string) {
  const s = getSession(sid)
  if (s && !s.seen) patchSession(sid, { seen: true })
}

/** Resume a historical transcript (Claude/Codex) as a new live Helm session. */
export function resumeTranscript(input: { projectId: string; provider: Exclude<ProviderId, 'shell'>; agentSessionId: string; name: string; cwd?: string }) {
  const project = getProject(input.projectId)!
  const t = now()
  const sid = id('ses')
  db.prepare(
    `INSERT INTO sessions(id, project_id, name, provider, cwd, status, agent_session_id, created_at, last_activity_at)
     VALUES(?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
  ).run(sid, project.id, input.name.slice(0, 48), input.provider, input.cwd && existsSync(input.cwd) ? input.cwd : project.path, input.agentSessionId, t, t)
  spawnSession(sid, { resume: true })
  return getSession(sid)!
}

/**
 * On daemon boot: reattach to every terminal still running in the terminal host (a service restart leaves them
 * untouched). Anything else that was "live" ended with the host or the machine — mark it for resume.
 */
export async function reconcileOnBoot() {
  db.prepare("UPDATE tasks SET review_error = 'AI review was interrupted by a daemon restart. Run AI review again.' WHERE status = 'ai_review' AND review_error = ''").run()
  let hostTerms: Awaited<ReturnType<typeof connectHost>>['terms'] = []
  if (usingHost()) {
    try {
      hostTerms = (await connectHost()).terms
    } catch (e) {
      log('terminal host unavailable at boot; terminals run inside hubd this session', e)
      disableHost()
    }
  }
  let adopted = 0
  for (const t of hostTerms) {
    const s = getSession(t.id)
    if (!s || s.archived) {
      discardTerminal(t.id)
      continue
    }
    const { proc, screen, exit } = await adoptTerminal(t)
    const ended = exit !== null ? exit : t.exit
    if (ended !== null) {
      // It finished while hubd was down: record the exit with its final screen.
      finalScreens.set(t.id, screen)
      saveScreen(t.id, screen)
      patchSession(t.id, { status: ended === 0 ? 'exited' : 'error', statusDetail: ended === 0 ? '' : `exit ${ended}`, exitCode: ended, exitedAt: now(), pid: null, recoveryPending: false }, false)
      releaseTerminal(t.id)
      continue
    }
    wire(t.id, proc, t.cols, t.rows, screen)
    // Parsing is async: let the restored screen land before anyone asks for a snapshot.
    await new Promise<void>((r) => live.get(t.id)!.mirror.write('', r))
    const status: SessionStatus = s.status === 'exited' || s.status === 'error' ? (s.provider === 'shell' ? 'idle' : 'running') : s.status
    patchSession(t.id, { pid: t.pid, status, statusDetail: s.status === status ? s.statusDetail : '', recoveryPending: false, exitCode: null, exitedAt: null }, false)
    adopted++
  }
  const stale = db.prepare(`SELECT id FROM sessions WHERE status NOT IN ('exited','error') AND archived = 0`).all() as { id: string }[]
  let lost = 0
  for (const { id: sid } of stale) {
    if (live.has(sid)) continue
    patchSession(sid, { status: 'exited', statusDetail: 'Helm restarted — resume with saved context', recoveryPending: true, pid: null, exitedAt: now() }, false)
    lost++
  }
  log(`reconciled sessions: ${adopted} still running, ${lost} to resume`)
}

/** The database has the plain handoff; ANSI snapshots preserve the terminal view. */
export function checkpointAll() {
  for (const [sid, l] of live) {
    try {
      saveScreen(sid, l.serializer.serialize())
      const b = l.mirror.buffer.active
      const lines: string[] = []
      for (let i = Math.max(0, b.length - 100); i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) || '')
      db.prepare('UPDATE sessions SET screen_text = ?, checkpoint_at = ? WHERE id = ?').run(lines.join('\n').slice(-16000), now(), sid)
    } catch (e) { log('checkpoint failed', sid, e) }
  }
}

export function startCheckpoints() {
  const timer = setInterval(checkpointAll, 5000)
  timer.unref()
  return () => clearInterval(timer)
}

/** hubd is stopping. Terminals in the host keep running for the next hubd; in-process ones end here. */
export function shutdownAll() {
  checkpointAll()
  for (const [sid, l] of live) {
    try {
      saveScreen(sid, l.serializer.serialize())
    } catch {}
    if (usingHost()) continue
    try {
      l.proc.kill()
    } catch {}
  }
  if (usingHost()) {
    detachHost()
    live.clear()
  }
}

export function liveCount() {
  return live.size
}
