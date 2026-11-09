// Run after pnpm build. Uses three scratch projects and never starts an AI provider.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import WebSocket from 'ws'
const require = createRequire(import.meta.url)
const scratch = mkdtempSync(join(tmpdir(), 'helm-reboot-'))
let daemon, info, ws
const sleep = (n) => new Promise((r) => setTimeout(r, n))
async function api(path, body) {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await res.json()
  assert.ok(res.ok, JSON.stringify(data))
  return data
}
async function start() {
  daemon = spawn(process.env.HELM_TEST_RUNTIME || require('electron'), [resolve('out/main/daemon.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HELM_DATA_DIR: scratch, HELM_PORT: '47961', CODEX_HOME: join(scratch, 'codex'), QWEN_HOME: join(scratch, 'qwen') }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try {
      info = JSON.parse(readFileSync(join(scratch, 'daemon.json'), 'utf8'))
      if (info.pid === daemon.pid && (await api('/status')).pid === daemon.pid) return
    } catch {}
    await sleep(200)
  }
  throw new Error(`Daemon did not start: ${scratch}`)
}
async function stop(signal = 'SIGTERM') {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode) return
  const exited = once(daemon, 'exit')
  daemon.kill(signal)
  await exited
}
async function socket() {
  ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?token=${info.token}`)
  await once(ws, 'open')
}
const host = () => JSON.parse(readFileSync(join(scratch, 'runtime/ptyhost.json'), 'utf8'))
const sessions = []
try {
  await start()
  await socket()
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    const path = join(scratch, name)
    mkdirSync(path)
    const project = await api('/projects', { path, name, goal: `${name} objective` })
    const task = await api('/tasks', { projectId: project.id, title: `${name} remaining work`, acceptance: `${name} verification` })
    const session = await api('/sessions', { projectId: project.id, taskId: task.id, provider: 'shell', prompt: `${name} original instructions` })
    sessions.push({ ...session, task, name, path })
    ws.send(JSON.stringify({ t: 'pty.input', sessionId: session.id, data: `export PROOF=${name}_SHELL_STATE; printf '${name}_BEFORE_REBOOT\\n'\r` }))
  }
  // Deliberately rely on the periodic timer, not the explicit checkpoint endpoint.
  await sleep(6200)
  for (const s of sessions) {
    const context = (await api(`/sessions/${s.id}/recovery`)).context
    assert.match(context, new RegExp(`${s.name}_BEFORE_REBOOT`))
    assert.match(context, new RegExp(`${s.name} original instructions`))
    for (const other of sessions.filter((o) => o.id !== s.id)) assert.ok(!context.includes(`${other.name} remaining work`))
  }
  const pids = Object.fromEntries((await api('/sessions')).map((s) => [s.id, s.pid]))
  assert.ok(sessions.every((s) => pids[s.id] > 0))
  ws.close()

  // Service restarts (abrupt, then clean) leave every terminal running in the terminal host.
  for (const signal of ['SIGKILL', 'SIGTERM']) {
    await stop(signal)
    await start()
    const after = await api('/sessions')
    for (const s of sessions) {
      const row = after.find((r) => r.id === s.id)
      assert.equal(row.pid, pids[s.id], `${s.name} kept its process after ${signal}`)
      assert.notEqual(row.status, 'exited')
      assert.equal(row.recoveryPending, false)
    }
    await socket()
    for (const s of sessions) ws.send(JSON.stringify({ t: 'pty.input', sessionId: s.id, data: `printf "$PROOF" > survived-${signal}.txt\r` }))
    for (let i = 0; i < 50 && !sessions.every((s) => existsSync(join(s.path, `survived-${signal}.txt`))); i++) await sleep(100)
    for (const s of sessions) assert.equal(readFileSync(join(s.path, `survived-${signal}.txt`), 'utf8'), `${s.name}_SHELL_STATE`)
    ws.close()
  }

  // Machine reboot: the terminal host is gone too. Sessions fall back to resume with saved context.
  process.kill(host().pid, 'SIGKILL')
  await stop('SIGKILL')
  await start()
  const restored = await api('/sessions')
  assert.equal(restored.filter((s) => s.recoveryPending).length, 3)
  assert.ok(restored.every((s) => s.status === 'exited'))
  for (const s of sessions) {
    assert.match(readFileSync(join(scratch, 'runtime/screens', `${s.id}.ans`), 'utf8'), new RegExp(`${s.name}_BEFORE_REBOOT`))
    assert.equal((await api(`/tasks/${s.task.id}`)).task.status, 'in_progress')
  }
  const results = await api('/workspace/resume', {})
  assert.equal(results.length, 3)
  assert.ok(results.every((s) => !s.error), JSON.stringify(results))
  assert.equal((await api('/workspace/resume', {})).length, 0, 'Repeated restore must not duplicate sessions')
  await socket()
  for (const s of sessions) ws.send(JSON.stringify({ t: 'pty.input', sessionId: s.id, data: `pwd > recovered-cwd.txt\r` }))
  for (let i = 0; i < 50 && !sessions.every((s) => existsSync(join(s.path, 'recovered-cwd.txt'))); i++) await sleep(100)
  for (const s of sessions) {
    assert.ok(existsSync(join(s.path, 'recovered-cwd.txt')))
    assert.ok(readFileSync(join(s.path, 'recovered-cwd.txt'), 'utf8').trim().endsWith(`/${s.name}`))
  }
  ws.close()
  await stop()
  await start()
  const resumed = await api('/sessions')
  assert.equal(resumed.filter((s) => s.recoveryPending).length, 0, 'Resumed sessions also survive a clean restart')
  assert.ok(resumed.every((s) => s.status !== 'exited'))
  console.log('PASS: three projects, terminals survive abrupt and clean service restarts (same process, shell state, input), reboot falls back to recovery with periodic screens, original prompts, task state, isolated context, correct directories, idempotent restore')
} finally {
  ws?.close()
  await stop()
  try { process.kill(host().pid, 'SIGTERM') } catch {}
  rmSync(scratch, { recursive: true, force: true })
}
