import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, symlinkSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import Database from 'better-sqlite3'
import { db, openDb, setSetting } from './db'
import { DATA_DIR, CODEX_HOME, QWEN_HOME } from './paths'
import { sessionToken } from './auth'
import { runtime, initRuntime } from './runtime'
import { startServer, stopServer } from './server'
import { registerCoreRoutes } from './routes'
import { createProject } from './services/projects'
import { createTask, updateTask, addEvidence, getTask, humanReview, addTaskEvent, createMilestone, listTasks, reviewQueue, applyPlan, archiveTask, renderProgressMarkdown } from './services/tasks'
import { diffFor, reviewFingerprint, reviewVersion, reviewIsCurrent, runAiReview } from './services/review'
import { getSession, createSession, shutdownAll, hasConversation, checkpointAll, reconcileOnBoot, snapshot, write, kill, restart, isLive } from './pty/manager'
import { configurePtyHost, hostInfo } from './ptyhost/client'
import { callTool } from './mcp/api'
import { findPathCandidates, pickExisting, rangeOnRow } from '../renderer/src/lib/pathlinks'
import { buildLaunch } from './providers'
import { codexConversation, indexFile, listTranscripts } from './transcripts/indexer'
import { shellEnv } from './env'
import { recoveryContext, saveHandoff } from './services/recovery'
import { handleHook } from './hooks'
import { listModels, refreshModels, setRole } from './services/models'
import { runHeadless } from './llm/runner'
let projectId: string, taskId: string, sid = 'ses_test', port: number
const repo = join(DATA_DIR, 'repo')
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
let base: string
before(async () => {
  mkdirSync(repo)
  git('init', '-q')
  writeFileSync(join(repo, 'example.txt'), 'before\n')
  git('add', '.')
  git('-c', 'user.name=Helm Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline')
  base = git('rev-parse', 'HEAD')
  projectId = createProject({ path: repo, name: 'Regression project' }).id
  taskId = createTask({ projectId, title: 'Review regression', acceptance: 'Evidence required' }).id
  db.prepare(`INSERT INTO sessions(id,project_id,task_id,name,provider,role,cwd,status,created_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(sid, projectId, taskId, 'Test implementer', 'codex', 'implement', repo, 'running', Date.now(), Date.now())
  updateTask(taskId, { sessionId: sid })
  registerCoreRoutes()
  port = await startServer(0)
  initRuntime(port)
})
after(async () => {
  shutdownAll()
  // Tests that used the terminal host leave it running by design; stop it here.
  const host = hostInfo()
  if (host) try { process.kill(host.pid, 'SIGTERM') } catch {}
  await stopServer()
  db.close()
})

async function request(path: string, token: string, session = sid, body?: unknown) {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Helm-Session': session },
    body: body === undefined ? undefined : JSON.stringify(body) })
}

test('session hooks are authenticated and cannot target another session', async () => {
  assert.equal((await request(`/hooks/codex/${sid}?event=notify`, sessionToken(sid), sid, { type: 'agent-turn-complete', 'thread-id': 'test-thread', 'last-assistant-message': 'Ready' })).status, 200)
  assert.equal(getSession(sid)?.agentSessionId, 'test-thread')
  assert.equal(getSession(sid)?.status, 'done')
  assert.equal((await request('/hooks/codex/other?event=notify', sessionToken(sid), sid, {})).status, 401)
})

test('hand edits in the file viewer reach the agent as context once, and dropped lines are flagged', async () => {
  const file = join(DATA_DIR, 'reply.txt')
  writeFileSync(file, 'Hey Brad,\nOld line here\nThanks\n')
  const ui = (body: unknown) => fetch(`http://127.0.0.1:${port}/files/user-edit`, { method: 'POST',
    headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  // A stale base (the agent rewrote the file meanwhile) is refused rather than clobbering it.
  assert.equal((await ui({ path: file, text: 'x', base: 'not what is on disk', sessionId: sid })).status, 409)
  const edited = 'Hey Brad,\nMy own wording stays\nThanks\n'
  assert.equal((await ui({ path: file, text: edited, base: readFileSync(file, 'utf8'), sessionId: sid })).status, 200)
  assert.equal(readFileSync(file, 'utf8'), edited)
  // Delivered through the real hook relay, so the script's stdout is what the CLI would read.
  const hook = (event: string, payload: unknown) => new Promise<string>((resolve) => {
    const p = spawn('/bin/sh', [runtime.hookScript, 'codex', event], { env: { ...process.env, HELM_URL: runtime.url, HELM_TOKEN: sessionToken(sid), HELM_SESSION_ID: sid } })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => resolve(out))
    p.stdin.end(JSON.stringify(payload))
  })
  const first = JSON.parse(await hook('UserPromptSubmit', { prompt: 'next thing' }))
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(first.hookSpecificOutput.additionalContext, /intentional/)
  assert.match(first.hookSpecificOutput.additionalContext, /- Old line here\n\+ My own wording stays/)
  assert.equal(await hook('UserPromptSubmit', { prompt: 'again' }), '')
  // An agent write that drops the user's line gets one warning, then stops nagging.
  writeFileSync(file, 'Hey Brad,\nAgent rewrite\nThanks\n')
  const warn = handleHook('codex', sid, 'PostToolUse', { tool_name: 'Write', tool_input: { file_path: file } }) as any
  assert.match(warn.hookSpecificOutput.additionalContext, /- My own wording stays/)
  assert.deepEqual(handleHook('codex', sid, 'PostToolUse', { tool_name: 'Write', tool_input: { file_path: file } }), {})
})

test('sidebar labels persist separately from conversation names and can be cleared', async () => {
  const original = getSession(sid)!.name
  const rename = (sidebarLabel: string) => fetch(`http://127.0.0.1:${port}/sessions/${sid}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sidebarLabel }),
  })
  assert.equal((await rename('  SEO  ')).status, 200)
  assert.equal(getSession(sid)!.sidebarLabel, 'SEO')
  assert.equal(getSession(sid)!.name, original)
  assert.equal((await rename('x'.repeat(65))).status, 400)
  assert.equal(getSession(sid)!.sidebarLabel, 'SEO')
  assert.equal((await rename('')).status, 200)
  assert.equal(getSession(sid)!.sidebarLabel, '')
})

test('workers cannot use Pilot tools, self-approve or access another project task', async () => {
  await assert.rejects(callTool('helm_session_send', sid, { sessionId: sid, text: 'yes' }), /Pilot/)
  await assert.rejects(callTool('helm_review_verdict', sid, { taskId, verdict: 'pass' }), /Unknown tool/)
  const other = createProject({ path: DATA_DIR, name: 'Other project' })
  const t = createTask({ projectId: other.id, title: 'Private task' })
  await assert.rejects(callTool('helm_task_get', sid, { taskId: t.id }), /another project/)
})

test('task create: no default milestone, unknown milestone is refused, an open task with the same title is returned instead of a duplicate', async () => {
  const ms = createMilestone({ projectId, title: 'Launch', status: 'active' })
  const made = (await callTool('helm_task_create', sid, { title: 'Write the launch email' })) as any
  assert.equal(made.milestone, null)
  assert.equal(getTask(made.created)?.milestoneId, null)
  await assert.rejects(callTool('helm_task_create', sid, { title: 'Other', milestone: 'Nope' }), /No milestone "Nope"/)
  const explicit = (await callTool('helm_task_create', sid, { title: 'Ship the launch', milestone: 'launch' })) as any
  assert.equal(getTask(explicit.created)?.milestoneId, ms.id)
  const again = (await callTool('helm_task_create', sid, { title: 'write the LAUNCH email!' })) as any
  assert.equal(again.existing, made.created)
  assert.equal(listTasks({ projectId }).filter((t) => t.title === 'Write the launch email').length, 1)
  // A closed task with that title no longer blocks a new one.
  await callTool('helm_task_close', sid, { taskId: made.created, outcome: 'done', reason: 'Sent' })
  assert.ok(((await callTool('helm_task_create', sid, { title: 'Write the launch email' })) as any).created)
})

test('sessions close and archive only their own tasks, with a reason, and never skip review', async () => {
  const own = ((await callTool('helm_task_create', sid, { title: 'Round 3 step: rebuild the deck' })) as any).created
  const userTask = createTask({ projectId, title: "The user's own task" }).id
  await assert.rejects(callTool('helm_task_close', sid, { taskId: own, outcome: 'done', reason: ' ' }), /reason/)
  await assert.rejects(callTool('helm_task_close', sid, { taskId: own, outcome: 'maybe', reason: 'x' }), /outcome/)
  await assert.rejects(callTool('helm_task_close', sid, { taskId: userTask, outcome: 'wont_do', reason: 'obsolete' }), /only tasks they created/)
  await assert.rejects(callTool('helm_task_archive', sid, { taskId: userTask, reason: 'dup' }), /only tasks they created/)
  updateTask(own, { status: 'human_review' })
  await assert.rejects(callTool('helm_task_close', sid, { taskId: own, outcome: 'done', reason: 'finished' }), /review/)
  await callTool('helm_task_close', sid, { taskId: own, outcome: 'wont_do', reason: 'Superseded by round 4' })
  let t = getTask(own)!
  assert.equal(t.status, 'wont_do')
  assert.equal(t.closedReason, 'Superseded by round 4')
  assert.ok(t.completedAt)
  assert.ok(!reviewQueue().some((x) => x.id === own))
  // Reopening clears the close.
  updateTask(own, { status: 'todo' })
  t = getTask(own)!
  assert.equal(t.closedReason, '')
  assert.equal(t.completedAt, null)
  assert.match(renderProgressMarkdown(projectId), /Round 3 step/)
  updateTask(own, { status: 'wont_do', closedReason: 'Superseded' })
  assert.doesNotMatch(renderProgressMarkdown(projectId), /Round 3 step/)
})

test('submission without evidence is rejected', async () => {
  await assert.rejects(callTool('helm_submit_for_review', sid, { taskId, summary: 'done' }), /evidence/)
  assert.notEqual(getTask(taskId)?.status, 'ai_review')
})

test('task and evidence edits invalidate a pending review even in the same millisecond', () => {
  updateTask(taskId, { status: 'ai_review' })
  let version = reviewVersion(taskId)
  assert.ok(reviewIsCurrent(taskId, version))
  updateTask(taskId, { acceptance: 'New criteria' })
  assert.ok(!reviewIsCurrent(taskId, version))
  version = reviewVersion(taskId)
  addEvidence({ taskId, sessionId: sid, kind: 'test', title: 'Tests', body: 'passed', path: null })
  assert.ok(!reviewIsCurrent(taskId, version))
  updateTask(taskId, { status: 'done' })
  assert.ok(!reviewIsCurrent(taskId, reviewVersion(taskId)))
})

test('committed implementation is included using the session baseline', () => {
  writeFileSync(join(repo, 'example.txt'), 'after\n')
  git('add', '.')
  git('-c', 'user.name=Helm Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'implementation')
  assert.equal(git('diff', 'HEAD'), '')
  assert.match(diffFor(repo, repo, base), /\+after/)
  const fingerprint = reviewFingerprint(repo)
  writeFileSync(join(repo, 'untracked.txt'), 'new evidence')
  assert.notEqual(reviewFingerprint(repo), fingerprint)
})

test('disabled automatic reviews surface an actionable error', async () => {
  setSetting('review.autoAi', false)
  updateTask(taskId, { status: 'ai_review' })
  await runAiReview(taskId)
  assert.match(getTask(taskId)!.reviewError, /disabled/)
  const items = await (await request('/needs-you', runtime.token)).json() as { id: string }[]
  assert.ok(items.some((x) => x.id === taskId))
})

test('human approval cannot skip independent AI review', () => {
  updateTask(taskId, { status: 'in_progress' })
  assert.throws(() => humanReview(taskId, 'approve', ''), /pass AI review/)
})

test('Codex launch uses scoped credentials, notifications and explicit resume ID', () => {
  const s = getSession(sid)!
  const launch = buildLaunch({ session: s, prompt: '--not-a-flag' })
  assert.equal(launch.env.HELM_TOKEN, sessionToken(sid))
  assert.ok(launch.args.includes('tui.notification_condition="always"'))
  assert.ok(launch.args.includes('--no-alt-screen'))
  assert.ok(launch.args.includes('tui.raw_output_mode=false'))
  assert.deepEqual(launch.args.slice(-2), ['--', '--not-a-flag'])
  const resumed = buildLaunch({ session: s, resume: true })
  assert.deepEqual(resumed.args.slice(-2), ['resume', 'test-thread'])
  assert.ok(resumed.args.includes('--no-alt-screen'))
  assert.ok(resumed.args.includes('tui.raw_output_mode=false'))
  assert.ok(!launch.args.includes('--dangerously-bypass-hook-trust'))
})

test('Qwen launch has catalog, scoped MCP, hooks, system context and stable resume', () => {
  refreshModels()
  const qwenModels = listModels().filter((m) => m.provider === 'qwen')
  assert.ok(qwenModels.some((m) => m.slug === 'coder-model' && m.efforts.includes('xhigh')))
  assert.ok(qwenModels.some((m) => m.slug === 'qwen3.7-plus'))
  const qid = 'ses_qwen_test'
  const agentId = '041fde16-da2a-4195-83eb-765176e12a38'
  const t = Date.now()
  db.prepare(`INSERT INTO sessions(id,project_id,name,provider,model,cwd,status,agent_session_id,created_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(qid, projectId, 'Qwen test', 'qwen', 'qwen3.7-plus', repo, 'idle', agentId, t, t)
  const s = getSession(qid)!
  const launch = buildLaunch({ session: s, systemContext: 'Private system context' })
  assert.notEqual(launch.agentSessionId, agentId)
  assert.deepEqual(launch.args.slice(0, 2), ['--session-id', launch.agentSessionId!])
  assert.equal(launch.env.HELM_TOKEN, sessionToken(qid))
  assert.match(launch.env.QWEN_CODE_SYSTEM_SETTINGS_PATH, /qwen-settings-ses_qwen_test\.json$/)
  // --mcp-config merges, so the project's own MCP servers stay available as they are for Claude/Codex.
  assert.ok(!launch.args.includes('--allowed-mcp-server-names'))
  assert.ok(launch.args.includes('--append-system-prompt'))
  assert.ok(!launch.args.includes('-i'))
  const settings = JSON.parse(readFileSync(launch.env.QWEN_CODE_SYSTEM_SETTINGS_PATH, 'utf8'))
  assert.deepEqual(settings.permissions, { allow: ['mcp__helm'] })
  assert.equal(settings.model, undefined)
  assert.match(settings.hooks.Stop[0].hooks[0].command, / qwen Stop$/)
  const resumed = buildLaunch({ session: s, resume: true })
  assert.equal(resumed.agentSessionId, agentId)
  assert.deepEqual(resumed.args.slice(0, 2), ['--resume', agentId])

  // Qwen has no --effort flag, so effort must travel through the generated settings file.
  db.prepare('UPDATE sessions SET effort = ? WHERE id = ?').run('high', qid)
  const withEffort = buildLaunch({ session: getSession(qid)! })
  assert.deepEqual(JSON.parse(readFileSync(withEffort.env.QWEN_CODE_SYSTEM_SETTINGS_PATH, 'utf8')).model, { reasoningEffort: 'high' })
  db.prepare('UPDATE sessions SET effort = NULL WHERE id = ?').run(qid)

  handleHook('qwen', qid, 'Notification', { session_id: agentId, notification_type: 'auth_success', message: 'Authenticated', detail: 'x'.repeat(5000) })
  assert.equal(getSession(qid)?.status, 'idle')
  handleHook('qwen', qid, 'Notification', { session_id: agentId, notification_type: 'permission_request', message: 'Approve tool' })
  assert.equal(getSession(qid)?.status, 'waiting')
  // Qwen re-fires UserPromptSubmit per model send; a text-less continuation must keep the live detail.
  handleHook('qwen', qid, 'PreToolUse', { session_id: agentId, tool_name: 'run_shell_command' })
  assert.equal(getSession(qid)?.statusDetail, 'Using run_shell_command')
  handleHook('qwen', qid, 'UserPromptSubmit', { session_id: agentId, prompt: '' })
  assert.equal(getSession(qid)?.status, 'running')
  assert.equal(getSession(qid)?.statusDetail, 'Using run_shell_command')
  handleHook('qwen', qid, 'UserPromptSubmit', { session_id: agentId, prompt: '', submitted_prompt: 'Do the next task' })
  assert.equal(getSession(qid)?.statusDetail, 'Do the next task')
  // Qwen sends idle_prompt after Stop; a finished turn must not be re-badged as "needs you".
  handleHook('qwen', qid, 'Stop', { session_id: agentId, last_assistant_message: 'All done' })
  assert.equal(getSession(qid)?.status, 'done')
  assert.equal(getSession(qid)?.statusDetail, 'All done')
  handleHook('qwen', qid, 'Notification', { session_id: agentId, notification_type: 'idle_prompt', message: 'Waiting for your input' })
  assert.equal(getSession(qid)?.status, 'done')
  // A real approval request still outranks a finished turn.
  handleHook('qwen', qid, 'Notification', { session_id: agentId, notification_type: 'permission_prompt', message: 'Approve tool' })
  assert.equal(getSession(qid)?.status, 'waiting')
  for (const row of db.prepare('SELECT payload FROM session_events WHERE session_id = ?').all(qid) as { payload: string }[]) assert.doesNotThrow(() => JSON.parse(row.payload))
})

test('Qwen headless maps tool modes, extracts structured output and surfaces failures', async () => {
  const binDir = join(DATA_DIR, 'fake-bin')
  const argsFile = join(DATA_DIR, 'qwen-args.txt')
  const stdinFile = join(DATA_DIR, 'qwen-stdin.txt')
  const scenFile = join(DATA_DIR, 'qwen-shim-scenario.txt')
  const settingsCopy = join(DATA_DIR, 'qwen-settings-copy.json')
  mkdirSync(binDir)
  const shim = join(binDir, 'qwen')
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat > '${stdinFile}'\nif [ -n "$QWEN_CODE_SYSTEM_SETTINGS_PATH" ]; then cat "$QWEN_CODE_SYSTEM_SETTINGS_PATH" > '${settingsCopy}'; else rm -f '${settingsCopy}'; fi\nread -r code < '${scenFile}'\nif [ "$code" != "0" ]; then echo 'shim failure' >&2; exit "$code"; fi\ntail -n +2 '${scenFile}'\n`)
  chmodSync(shim, 0o755)
  const env = shellEnv(), oldPath = env.PATH
  env.PATH = `${binDir}:${oldPath}`
  setRole({ role: 'data', provider: 'qwen', model: 'qwen3.7-plus', effort: null, extraArgs: '' })
  // Scenario file: first line is the exit code, the rest is stdout.
  const scenario = (exit: number, out: string) => writeFileSync(scenFile, `${exit}\n${out}\n`)
  const argsOf = () => readFileSync(argsFile, 'utf8').split('\n')
  const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1]
  const run = (o: { tools?: 'none' | 'read' | 'all'; schema?: object; timeoutMs?: number; extraArgs?: string[]; override?: { effort?: string | null } } = {}) =>
    runHeadless({ role: 'data', prompt: 'shim prompt', cwd: repo, timeoutMs: 5000, ...o })
  const ok = () => scenario(0, '[{"type":"result","subtype":"success","result":"QWEN_SHIM_OK"}]')
  try {
    // Only tools:'all' may act; every other mode is read-only analysis.
    const modes: [('none' | 'read' | 'all') | undefined, string][] = [[undefined, 'plan'], ['none', 'plan'], ['read', 'plan'], ['all', 'yolo']]
    for (const [tools, mode] of modes) {
      ok()
      await run({ tools })
      assert.equal(flagValue(argsOf(), '--approval-mode'), mode, `wrong approval mode for tools=${tools}`)
    }

    ok()
    const result = await run({ tools: 'read', schema: { type: 'object' } })
    assert.equal(result.text, 'QWEN_SHIM_OK')
    assert.equal(result.provider, 'qwen')
    assert.equal(result.model, 'qwen3.7-plus')
    const args = argsOf()
    assert.ok(args.includes('--output-format'))
    assert.ok(args.includes('--json-schema'))
    assert.equal(flagValue(args, '--model'), 'qwen3.7-plus')
    assert.equal(flagValue(args, '--max-wall-time'), '5s')
    // --bare would strip the auto-discovery carrying Coding Plan auth; won't-fix, see runner.ts.
    assert.ok(!args.includes('--bare'))
    // The prompt travels on stdin: `-p` is deprecated and argv would expose it to `ps`.
    assert.ok(!args.includes('-p'))
    assert.ok(!args.includes('shim prompt'))
    assert.equal(readFileSync(stdinFile, 'utf8'), 'shim prompt')

    // Sub-second budgets round up to the 1s minimum rather than being rejected as a typo.
    ok()
    await run({ timeoutMs: 400 })
    assert.equal(flagValue(argsOf(), '--max-wall-time'), '1s')

    // No schema means no --json-schema, so the flag never leaks into plain text runs.
    ok()
    await run({ tools: 'read' })
    assert.ok(!argsOf().includes('--json-schema'))

    // structured_output wins over result text, and the LAST result event is the answer.
    scenario(0, '[{"type":"result","result":"STALE"},{"type":"result","subtype":"success","structured_output":{"ok":true,"n":3}}]')
    const shaped = await run({ tools: 'none', schema: { type: 'object' } })
    assert.equal(shaped.text, '{"ok":true,"n":3}')
    assert.deepEqual(shaped.json, { ok: true, n: 3 })

    // Caller-supplied args reach the CLI unchanged.
    ok()
    await run({ extraArgs: ['--fallback-model', 'qwen3-coder-flash'] })
    assert.equal(flagValue(argsOf(), '--fallback-model'), 'qwen3-coder-flash')

    // Effort has no CLI flag, so it must reach the run through per-run system settings. With no
    // effort the file is still injected but empty, so an ambient QWEN_CODE_SYSTEM_SETTINGS_PATH
    // inherited from a Helm-launched Qwen terminal cannot leak into a headless run.
    assert.deepEqual(JSON.parse(readFileSync(settingsCopy, 'utf8')), {})
    setRole({ role: 'data', provider: 'qwen', model: 'qwen3.7-plus', effort: 'high', extraArgs: '' })
    ok()
    await run({ tools: 'read' })
    assert.deepEqual(JSON.parse(readFileSync(settingsCopy, 'utf8')), { model: { reasoningEffort: 'high' } })
    // A per-call override wins over the role's saved effort.
    ok()
    await run({ tools: 'read', override: { effort: 'low' } })
    assert.deepEqual(JSON.parse(readFileSync(settingsCopy, 'utf8')), { model: { reasoningEffort: 'low' } })
    setRole({ role: 'data', provider: 'qwen', model: 'qwen3.7-plus', effort: null, extraArgs: '' })

    // A nonzero exit must surface with the CLI's stderr, not parse as an empty success.
    scenario(7, '')
    await assert.rejects(() => run({ tools: 'read' }), /qwen exited 7: shim failure/)
  } finally {
    env.PATH = oldPath
  }
})

test('xterm parses OSC notifications split across PTY chunks', async () => {
  const term = new Terminal({ allowProposedApi: true })
  const messages: string[] = []
  term.parser.registerOscHandler(9, (m) => { messages.push(m); return true })
  for (const part of ['\x1b]', '9;Approval re', 'quested: command', '\x07']) await new Promise<void>((resolve) => term.write(part, resolve))
  assert.deepEqual(messages, ['Approval requested: command'])
  term.dispose()
})

test('Codex output includes reasoning once; partial JSONL lines are retried', async () => {
  const path = join(DATA_DIR, 'rollout-test-token-session.jsonl')
  const line = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n'
  writeFileSync(path, line('session_meta', { id: 'token-session', cwd: repo }) + line('turn_context', { model: 'test-model' }) + line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 20 } } }))
  await indexFile(path, 'codex')
  const row = db.prepare('SELECT tokens_in, tokens_out FROM transcripts WHERE agent_session_id = ?').get('token-session') as any
  assert.deepEqual(row, { tokens_in: 60, tokens_out: 30 })
  const message = line('event_msg', { type: 'agent_message', message: 'Complete message' })
  appendFileSync(path, message.slice(0, 20))
  await indexFile(path, 'codex')
  appendFileSync(path, message.slice(20))
  await indexFile(path, 'codex')
  assert.equal((db.prepare("SELECT count(*) n FROM transcript_fts WHERE text = 'Complete message'").get() as any).n, 1)
})

test('live Codex conversation keeps full Markdown and appends completed messages once', async () => {
  const agentId = '11111111-2222-3333-4444-555555555555'
  const dir = join(CODEX_HOME, 'sessions', '2026', '10', '15')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-test-${agentId}.jsonl`)
  const line = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n'
  const answer = `### Heading\n\n\`\`\`ts\n  ${'x'.repeat(4100)}\n\`\`\``
  writeFileSync(path, line('session_meta', { id: agentId, cwd: repo }) +
    line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'Question' }] } }) +
    line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ text: answer }] } }) +
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }))
  assert.deepEqual((await codexConversation(agentId)).map((m) => m.role), ['user', 'assistant'])
  assert.equal((await codexConversation(agentId))[1].text, answer)
  appendFileSync(path, line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'Follow-up' }] } }))
  assert.deepEqual((await codexConversation(agentId)).map((m) => m.text.slice(0, 9)), ['Question', '### Headi', 'Follow-up'])
})

test('failed launches become errors rather than permanent starting sessions', async () => {
  const env = shellEnv(), originalShell = env.SHELL
  env.SHELL = join(DATA_DIR, 'missing-shell')
  try { createSession({ projectId, provider: 'shell' }) }
  catch {}
  finally { env.SHELL = originalShell }
  const latest = () => db.prepare("SELECT status FROM sessions WHERE id != ? AND project_id = ? ORDER BY created_at DESC LIMIT 1").get(sid, projectId) as any
  for (let i = 0; i < 40 && latest()?.status !== 'error'; i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(latest()?.status, 'error')
})


test('Codex resume survives an empty transcript index during rebuild', () => {
  const dir = join(CODEX_HOME, 'sessions', '2026', '09', '26')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rollout-test-thread.jsonl'), '{}\n')
  assert.equal(hasConversation(getSession(sid)!), true)
})

test('Qwen resume needs a recorded chat, not the sibling runtime file', () => {
  const id = 'ses_qwen_conv'
  const agentId = '7b1c9f2e-aaaa-bbbb-cccc-ddddeeeeffff'
  const t = Date.now()
  db.prepare(`INSERT INTO sessions(id,project_id,name,provider,model,cwd,status,agent_session_id,created_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, projectId, 'Qwen conv', 'qwen', 'qwen3.7-plus', repo, 'idle', agentId, t, t)
  const dir = join(QWEN_HOME, 'projects', '-scratch-repo', 'chats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${agentId}.runtime.json`), '{}')
  assert.equal(hasConversation(getSession(id)!), false)
  writeFileSync(join(dir, `${agentId}.jsonl`), '{}\n')
  assert.equal(hasConversation(getSession(id)!), true)
})

test('Qwen chats index messages and token usage, excluding reasoning', async () => {
  const dir = join(QWEN_HOME, 'projects', '-qwen-index', 'chats')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'qwen-index-1.jsonl')
  const e = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 'qwen-index-1', cwd: repo, ...o }) + '\n'
  writeFileSync(path,
    e({ uuid: 'u1', timestamp: '2026-09-28T10:00:00.000Z', type: 'user', message: { role: 'user', parts: [{ text: 'Index this qwen chat' }] } }) +
    e({ uuid: 't1', timestamp: '2026-09-28T10:00:02.000Z', type: 'user', message: { role: 'user', parts: [{ functionResponse: { name: 'read_file' } }] } }) +
    e({ uuid: 'a1', timestamp: '2026-09-28T10:00:05.000Z', type: 'assistant', model: 'qwen3.7-plus', message: { role: 'model', parts: [{ text: 'SECRET_REASONING', thought: true }, { text: 'Done.' }] } }) +
    e({ uuid: 's1', timestamp: '2026-09-28T10:00:06.000Z', type: 'system', subtype: 'ui_telemetry', systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_response', model: 'qwen3.7-plus', input_token_count: 1000, output_token_count: 50, cached_content_token_count: 400 } } }))
  assert.equal(await indexFile(path, 'qwen'), true)
  const row = db.prepare('SELECT * FROM transcripts WHERE agent_session_id = ?').get('qwen-index-1') as any
  assert.equal(row.source, 'qwen')
  assert.equal(row.model, 'qwen3.7-plus')
  assert.equal(row.message_count, 2)
  // Cache reads are excluded, matching the Claude path.
  assert.equal(row.tokens_in, 600)
  assert.equal(row.tokens_out, 50)
  assert.equal(row.first_prompt, 'Index this qwen chat')
  assert.equal(row.title, 'Index this qwen chat')
  const fts = db.prepare('SELECT role, text FROM transcript_fts WHERE transcript_id = ? ORDER BY rowid').all(row.id) as any[]
  assert.deepEqual(fts.map((f) => [f.role, f.text]), [['user', 'Index this qwen chat'], ['assistant', 'Done.']])
  assert.deepEqual(db.prepare('SELECT provider, model, tokens_in, tokens_out FROM usage WHERE transcript_id = ?').all(row.id),
    [{ provider: 'qwen', model: 'qwen3.7-plus', tokens_in: 600, tokens_out: 50 }])
  assert.ok(listTranscripts({}).some((t) => t.source === 'qwen' && t.agentSessionId === 'qwen-index-1'))
})

test('current Codex completed items index user and assistant text without response-item duplication', async () => {
  const path = join(DATA_DIR, 'current-format.jsonl')
  const line = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n'
  writeFileSync(path,
    line('session_meta', { id: 'current-format', cwd: repo }) +
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Current format question' }] }) +
    line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Current format question' }] } }) +
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Current format answer' }] }) +
    line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Current format answer' }] } }))
  await indexFile(path, 'codex')
  const row = db.prepare('SELECT id, message_count FROM transcripts WHERE agent_session_id = ?').get('current-format') as any
  assert.equal(row.message_count, 2)
  assert.equal((db.prepare('SELECT count(*) n FROM transcript_fts WHERE transcript_id = ?').get(row.id) as any).n, 2)
})


test('symlinked project paths find the same project and Codex history', () => {
  const alias = join(DATA_DIR, 'repo-alias')
  symlinkSync(repo, alias)
  assert.equal(createProject({ path: alias }).id, projectId)
  assert.ok(listTranscripts({ projectPath: alias }).some((t) => t.agentSessionId === 'current-format'))
})

test('reindex preserves history on invalid source and replaces valid derived rows atomically', async () => {
  const path = join(DATA_DIR, 'rollout-test-token-session.jsonl')
  const original = readFileSync(path, 'utf8')
  const row = db.prepare("SELECT id FROM transcripts WHERE agent_session_id = 'token-session'").get() as { id: string }
  db.prepare('UPDATE transcripts SET needs_reindex = 1 WHERE id = ?').run(row.id)
  writeFileSync(path, '{incomplete')
  assert.equal(await indexFile(path, 'codex'), false)
  assert.equal((db.prepare('SELECT count(*) n FROM transcript_fts WHERE transcript_id = ?').get(row.id) as any).n, 1)
  writeFileSync(path, original)
  await indexFile(path, 'codex')
  assert.equal((db.prepare('SELECT count(*) n FROM transcript_fts WHERE transcript_id = ?').get(row.id) as any).n, 1)
  assert.equal((db.prepare('SELECT sum(tokens_out) n FROM usage WHERE transcript_id = ?').get(row.id) as any).n, 30)
  assert.equal((db.prepare('SELECT needs_reindex n FROM transcripts WHERE id = ?').get(row.id) as any).n, 0)
})


test('Codex usage accumulates across resumed CLI counter resets and incremental scans', async () => {
  const path = join(DATA_DIR, 'usage-resume.jsonl')
  const line = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n'
  const usage = (input: number, cached: number, output: number) => line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } })
  writeFileSync(path, line('session_meta', { id: 'usage-resume', cwd: repo }) + usage(100, 40, 30))
  await indexFile(path, 'codex')
  appendFileSync(path, usage(80, 20, 10) + usage(160, 100, 15))
  await indexFile(path, 'codex')
  const row = db.prepare("SELECT tokens_in, tokens_out FROM transcripts WHERE agent_session_id = 'usage-resume'").get()
  assert.deepEqual(row, { tokens_in: 120, tokens_out: 45 })
})

test('recovery handoffs remain project scoped and include current task progress', async () => {
  mkdirSync(join(DATA_DIR, 'separate-project'))
  const other = createProject({ path: join(DATA_DIR, 'separate-project'), name: 'Recovery B' })
  createTask({ projectId: other.id, title: 'B_ONLY_DO_NOT_LEAK' })
  addTaskEvent(taskId, 'progress', sid, 'A_ONLY_NEXT_STEP: rerun build after reboot')
  saveHandoff(sid, 'Build interrupted; verify output before rerunning')
  db.prepare('UPDATE sessions SET initial_prompt = ?, screen_text = ?, checkpoint_at = ? WHERE id = ?')
    .run('Original A objective', 'A screen output', Date.now(), sid)
  const context = recoveryContext(sid)
  assert.match(context, /A_ONLY_NEXT_STEP/)
  assert.match(context, /Original A objective/)
  assert.match(context, /Build interrupted/)
  assert.match(context, /A screen output/)
  assert.doesNotMatch(context, /B_ONLY_DO_NOT_LEAK/)
  await callTool('helm_checkpoint', sid, { note: 'MCP saved next steps' })
  assert.match(recoveryContext(sid), /MCP saved next steps/)
  assert.throws(() => saveHandoff(sid, ''), /1–16000/)
})

test('Codex resume receives fresh recovery context and fresh launch discards old thread identity', () => {
  const session = { ...getSession(sid)!, provider: 'codex' as const, agentSessionId: 'saved-thread' }
  const resumed = buildLaunch({ session, resume: true, prompt: 'Recovery next step', systemContext: 'Task instructions' })
  const idx = resumed.args.indexOf('resume')
  assert.deepEqual(resumed.args.slice(idx), ['resume', 'saved-thread', '--', 'Task instructions\n\nRecovery next step'])
  assert.equal(resumed.agentSessionId, 'saved-thread')
  const fresh = buildLaunch({ session, resume: false, prompt: 'Recovery next step' })
  assert.equal(fresh.agentSessionId, null)
})

test('periodic checkpoint persists a live terminal and boot marks it recoverable without completing its task', async () => {
  const s = createSession({ projectId, provider: 'shell', prompt: 'Keep my objective' })
  write(s.id, "printf 'RECOVERY_SHELL_MARKER\\n'\r")
  await new Promise((resolve) => setTimeout(resolve, 700))
  checkpointAll()
  assert.match(snapshot(s.id), /RECOVERY_SHELL_MARKER/)
  const saved = db.prepare('SELECT screen_text, initial_prompt, checkpoint_at FROM sessions WHERE id=?').get(s.id) as any
  assert.match(saved.screen_text, /RECOVERY_SHELL_MARKER/)
  assert.equal(saved.initial_prompt, 'Keep my objective')
  assert.ok(saved.checkpoint_at)
  kill(s.id)
  await new Promise((resolve) => setTimeout(resolve, 200))
  db.prepare("UPDATE sessions SET status='running', cwd=? WHERE id=?").run(join(DATA_DIR, 'missing-worktree'), s.id)
  const beforeStatus = getTask(taskId)!.status
  await reconcileOnBoot()
  assert.equal(getSession(s.id)?.recoveryPending, true)
  assert.equal(getSession(s.id)?.status, 'exited')
  assert.equal(getTask(taskId)!.status, beforeStatus)
  assert.throws(() => restart(s.id), /Working directory is missing/)
  assert.equal(getSession(s.id)?.recoveryPending, true)
})


test('an older build refuses a database with a newer schema without modifying its contents', () => {
  const path = join(DATA_DIR, 'future-schema.sqlite')
  const future = new Database(path)
  future.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('future data')")
  future.pragma('user_version = 999')
  future.close()
  assert.throws(() => openDb(path), /needs a newer Helm build/)
  const unchanged = new Database(path, { readonly: true })
  assert.equal(unchanged.pragma('user_version', { simple: true }), 999)
  assert.deepEqual(unchanged.prepare('SELECT value FROM preserved').get(), { value: 'future data' })
  unchanged.close()
})




test('terminal host: shells keep running across a hubd restart; exits while hubd is down are recorded; losing the host makes them resumable', async () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn: () => boolean, ms = 5000) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn() }
  configurePtyHost({ script: join(__dirname, 'ptyhost.cjs'), daemonToken: 'test-token' })
  await reconcileOnBoot() // starts the host
  const host = hostInfo()!
  assert.ok(host.pid)

  const a = createSession({ projectId, provider: 'shell', name: 'Survivor' })
  const b = createSession({ projectId, provider: 'shell', name: 'Ends while hubd is down' })
  assert.ok(await until(() => !!getSession(a.id)?.pid && !!getSession(b.id)?.pid))
  const pidA = getSession(a.id)!.pid!, pidB = getSession(b.id)!.pid!
  write(a.id, "export HOST_PROOF=kept; printf 'BEFORE_RESTART\\n'\r")
  assert.ok(await until(() => /BEFORE_RESTART/.test(snapshot(a.id))))

  // hubd stops: nothing is killed.
  shutdownAll()
  assert.equal(isLive(a.id), false)
  process.kill(pidA, 0)
  process.kill(pidB, 'SIGKILL') // b ends while no hubd is attached

  // hubd starts again and reattaches.
  configurePtyHost({ script: join(__dirname, 'ptyhost.cjs'), daemonToken: 'test-token' })
  await reconcileOnBoot()
  assert.equal(hostInfo()!.pid, host.pid, 'same host')
  assert.equal(isLive(a.id), true)
  assert.equal(getSession(a.id)!.pid, pidA)
  assert.equal(getSession(a.id)!.recoveryPending, false)
  assert.match(snapshot(a.id), /BEFORE_RESTART/, 'screen continuity')
  write(a.id, "printf \"AFTER_$HOST_PROOF\\n\"\r")
  assert.ok(await until(() => /AFTER_kept/.test(snapshot(a.id))), 'same shell state, input works')
  assert.equal(isLive(b.id), false)
  assert.notEqual(getSession(b.id)!.status, 'running')
  assert.equal(getSession(b.id)!.recoveryPending, false)

  // The host itself goes away (crash or reboot): sessions become resumable instead of failed.
  process.kill(host.pid, 'SIGKILL')
  assert.ok(await until(() => getSession(a.id)?.recoveryPending === true))
  assert.equal(getSession(a.id)!.status, 'exited')
  assert.throws(() => process.kill(pidA, 0))

  // A new session starts a fresh host on demand.
  const c = createSession({ projectId, provider: 'shell', name: 'After host loss' })
  assert.ok(await until(() => !!getSession(c.id)?.pid))
  assert.notEqual(hostInfo()!.pid, host.pid)
  kill(c.id)
  assert.ok(await until(() => !isLive(c.id)))
  await wait(1100) // let the exited session's activity timer settle
  shutdownAll()
  try { process.kill(hostInfo()!.pid, 'SIGTERM') } catch {}
  configurePtyHost({ script: null, daemonToken: 'test-token' })
})

// ---- ⌘-clickable paths in terminal output ----
async function screen(cols: number, text: string) {
  const t = new Terminal({ cols, rows: 12, allowProposedApi: true })
  await new Promise<void>((r) => t.write(text, r))
  return t
}
const linksOn = (t: Terminal, row: number, cwd: string | undefined, existing: string[]) =>
  pickExisting(findPathCandidates(t.buffer.active, t.cols, row, cwd, '/Users/alex'), (p) => existing.includes(p))

test('terminal paths: a path the agent hard-wrapped (indent, split at a hyphen) is one link on both rows', async () => {
  const video = '/Users/alex/Developer/example-project/.bb-qa/clips/logo-swap.mp4'
  const t = await screen(50, '• Watch it (/Users/alex/Developer/example-\r\n  project/.bb-qa/clips/logo-swap.mp4).\r\nnext line')
  for (const row of [0, 1]) {
    const [link, ...rest] = linksOn(t, row, undefined, [video])
    assert.equal(link?.path, video)
    assert.equal(rest.length, 0)
  }
  const [top] = linksOn(t, 0, undefined, [video])
  assert.deepEqual(rangeOnRow(top, 0), { start: { x: 13, y: 1 }, end: { x: 42, y: 1 } })
  assert.deepEqual(rangeOnRow(top, 1), { start: { x: 3, y: 2 }, end: { x: 36, y: 2 } })
  assert.equal(linksOn(t, 2, undefined, [video]).length, 0)
  assert.equal(linksOn(t, 0, undefined, []).length, 0, 'nothing that does not exist becomes a link')
})

test('terminal paths: soft-wrapped paths, relative paths with line numbers, and wide characters', async () => {
  const long = '/Users/alex/Developer/helm/src/renderer/src/components/FileViewer.tsx'
  const soft = await screen(30, `saved ${long}`)
  assert.equal(linksOn(soft, 1, undefined, [long])[0]?.path, long)
  const rel = await screen(80, '完成 src/x.ts:12:4 and/or stuff')
  const [hit] = linksOn(rel, 0, '/p', ['/p/src/x.ts'])
  assert.deepEqual({ path: hit.path, line: hit.line, col: hit.col }, { path: '/p/src/x.ts', line: 12, col: 4 })
  assert.equal(rangeOnRow(hit, 0).start.x, 6)
})

test('terminal paths: a wrong stitch never beats the real path, and URLs are left to the web-links addon', async () => {
  const t = await screen(40, 'Updated the page at src/app/page.tsx\r\n  and then ran the tests')
  const picked = linksOn(t, 0, '/p', ['/p/src/app/page.tsx'])
  assert.deepEqual(picked.map((l) => l.path), ['/p/src/app/page.tsx'])
  const url = await screen(80, 'see https://example.com/a/b.png now')
  assert.equal(findPathCandidates(url.buffer.active, 80, 0, '/p', '/Users/alex').some((c) => c.path.includes('/a/b.png')), false)
})

test('session credentials permit own MCP, deny settings and human approval', async () => {
  const token = sessionToken(sid)
  assert.notEqual(token, runtime.token)
  assert.equal((await request('/mcp-api/call/helm_whoami', token, sid, {})).status, 200)
  for (const [path, body] of [['/settings', undefined], [`/tasks/${taskId}/review`, { verdict: 'approve' }]] as const) {
    assert.equal((await request(path, token, sid, body)).status, 401)
  }
  assert.equal((await request('/mcp-api/context', token, 'ses_forged')).status, 401)
  assert.equal((await request('/settings', runtime.token)).status, 200)
})

test('archive hides a task from lists, reviews and plan re-application; restore brings it back with history', async () => {
  const ms = createMilestone({ projectId, title: 'Review rounds' })
  const t = createTask({ projectId, milestoneId: ms.id, title: 'Stale review step' })
  updateTask(t.id, { status: 'human_review' })
  addTaskEvent(t.id, 'progress', 'user', 'kept note')
  const token = runtime.token
  assert.equal((await request(`/tasks/${t.id}/archive`, sessionToken(sid), sid, { reason: 'x' })).status, 401)
  assert.equal((await request(`/tasks/${t.id}/archive`, token, sid, { reason: 'Not owed, close' })).status, 200)
  const a = getTask(t.id)!
  assert.ok(a.archivedAt)
  assert.equal(a.archivedReason, 'Not owed, close')
  assert.equal(a.status, 'human_review')
  assert.ok(!listTasks({ projectId }).some((x) => x.id === t.id))
  assert.ok(!reviewQueue().some((x) => x.id === t.id))
  assert.ok(!((await callTool('helm_task_list', sid, {})) as any[]).some((x) => x.id === t.id))
  const only = (await (await request(`/tasks?projectId=${projectId}&archived=only`, token)).json()) as any[]
  assert.deepEqual(only.map((x) => x.id).filter((x) => x === t.id), [t.id])
  assert.ok(only.every((x) => x.archivedAt))
  applyPlan(projectId, { milestones: [{ title: 'Review rounds', tasks: [{ title: 'Stale review step' }] }] })
  assert.equal(listTasks({ projectId, archived: 'include' }).filter((x) => x.title === 'Stale review step').length, 1)
  assert.equal(archiveTask(t.id, 'again').archivedReason, 'Not owed, close')
  assert.equal((await request(`/tasks/${t.id}/restore`, token, sid, {})).status, 200)
  assert.equal(getTask(t.id)!.archivedAt, null)
  assert.ok(listTasks({ projectId }).some((x) => x.id === t.id))
  const events = (await (await request(`/tasks/${t.id}`, token)).json()) as any
  assert.deepEqual(events.events.map((e: any) => e.body).filter((b: string) => /kept note|Archived|Restored/.test(b)), ['kept note', 'Archived: Not owed, close', 'Restored from archive'])
  // Closing over REST needs a reason.
  assert.equal((await request(`/tasks/${t.id}/close`, token, sid, { outcome: 'done' })).status >= 400, true)
  assert.equal((await request(`/tasks/${t.id}/close`, token, sid, { outcome: 'wont_do', reason: 'Not owed' })).status, 200)
  assert.equal(getTask(t.id)!.status, 'wont_do')
})
