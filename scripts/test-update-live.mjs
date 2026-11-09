// Real packaged windows + daemon + PTY; all state stays in a temporary workspace.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import WebSocket from 'ws'
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'helm-update-live-')))
const data = join(scratch, 'data')
const target = join(scratch, 'Applications/Helm Core.app')
const sourceCandidate = resolve('release/mac-arm64/Helm Core.app')
const candidate = join(scratch, 'candidate/Helm Core.app')
const updater = resolve('scripts/helm-update.py')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let info, ws, uiPid, passed = false
const workers = []
function python(...args) { return execFileSync('python3', [updater, ...args], { encoding: 'utf8' }).trim() }
function cloneFixture(from, to) {
  // Keep test fixtures byte-for-byte identical without spending another full app bundle per fixture on APFS.
  // The updater still performs its real copy and verifies the staged bundle below.
  mkdirSync(dirname(to), { recursive: true })
  execFileSync('/bin/cp', ['-cR', from, to])
}
async function until(fn, message, timeout = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await fn()
    if (result) return result
    await sleep(200)
  }
  throw new Error(message)
}
async function update(app, expected = 'complete') {
  const jobPath = python('prepare', app, '--data', data, '--target', target, '--parent', String(uiPid || 0))
  const jobDir = resolve(jobPath, '..')
  const worker = spawn('python3', [updater, 'run', jobPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  workers.push(worker)
  let output = ''
  worker.stdout.on('data', (d) => { output += d })
  worker.stderr.on('data', (d) => { output += d })
  await until(() => {
    if (worker.exitCode !== null) throw new Error(output)
    return existsSync(join(jobDir, 'ready.json'))
  }, 'Updater did not stage')
  if (uiPid) process.kill(uiPid, 'SIGTERM')
  const job = await until(() => {
    const j = JSON.parse(readFileSync(jobPath, 'utf8'))
    return ['complete', 'rolled-back', 'failed', 'recovery-required'].includes(j.state) && j
  }, `Update did not finish: ${jobPath}`, 70_000)
  assert.equal(job.state, expected, JSON.stringify(job) + output)
  if (expected === 'complete') uiPid = JSON.parse(readFileSync(join(jobDir, 'healthy.json'), 'utf8')).pid
  else uiPid = undefined // rollback launches the prior UI; clean it by its executable below
  return job
}
async function api(path, body) {
  info = JSON.parse(readFileSync(join(data, 'daemon.json'), 'utf8'))
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await res.json()
  assert.ok(res.ok, JSON.stringify(value))
  return value
}
function killScratchWindows() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n')
  for (const row of rows) {
    const m = row.trim().match(/^(\d+)\s+(.+)$/)
    if (m && m[2].startsWith(scratch) && m[2].endsWith('/Contents/MacOS/Helm Core')) {
      try { process.kill(Number(m[1]), 'SIGTERM') } catch {}
    }
  }
}
try {
  mkdirSync(data)
  // Seal only a disposable copy for the acceptance test. The real release is
  // marked ready by prepare-update.sh only after this test succeeds.
  cloneFixture(sourceCandidate, candidate)
  python('seal', candidate)
  const first = await update(candidate)
  assert.ok(first.app.startsWith(data))
  const projectDir = join(scratch, 'Project')
  mkdirSync(projectDir)
  const project = await api('/projects', { name: 'Update continuity QA', path: projectDir })
  const session = await api('/sessions', { projectId: project.id, provider: 'shell', name: 'Persistent shell' })
  const oldPid = info.pid
  ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?token=${info.token}`)
  await once(ws, 'open')
  ws.send(JSON.stringify({ t: 'pty.input', sessionId: session.id, data: `export HELM_UPDATE_PROOF=survived; printf "$HELM_UPDATE_PROOF" > before.txt\r` }))
  await until(() => existsSync(join(projectDir, 'before.txt')), 'Shell did not start')
  await update(candidate)
  assert.equal((await api('/status')).pid, oldPid, 'Daemon PID must survive update')
  ws.send(JSON.stringify({ t: 'pty.input', sessionId: session.id, data: `printf "$HELM_UPDATE_PROOF" > after.txt\r` }))
  await until(() => existsSync(join(projectDir, 'after.txt')), 'Original shell did not respond after update')
  assert.equal(readFileSync(join(projectDir, 'after.txt'), 'utf8'), 'survived', 'Same shell environment must survive')
  // A deliberately broken main process passes bundle integrity but fails real startup health.
  const bad = join(scratch, 'bad/Helm Core.app')
  cloneFixture(candidate, bad)
  writeFileSync(join(bad, 'Contents/Resources/app/out/main/index.js'), 'process.exit(23)\n')
  python('seal', bad)
  await update(bad, 'rolled-back')
  assert.equal((await api('/status')).pid, oldPid)
  ws.send(JSON.stringify({ t: 'pty.input', sessionId: session.id, data: `printf "$HELM_UPDATE_PROOF" > rollback.txt\r` }))
  await until(() => existsSync(join(projectDir, 'rollback.txt')), 'Original shell did not respond after rollback')
  assert.equal(readFileSync(join(projectDir, 'rollback.txt'), 'utf8'), 'survived')
  passed = true
  console.log('PASS: packaged cold startup, verified promotion, unchanged daemon and live shell environment, failed startup rollback with live terminal intact')
} catch (error) {
  console.error('Update QA failed; diagnostics:', scratch, error)
  throw error
} finally {
  ws?.close()
  for (const worker of workers) if (worker.exitCode === null) worker.kill('SIGTERM')
  killScratchWindows()
  await sleep(1000)
  try { info = JSON.parse(readFileSync(join(data, 'daemon.json'), 'utf8')); process.kill(info.pid, 'SIGTERM') } catch {}
  // Terminals now live in helm-ptyhost, which outlives the service by design; end the scratch one.
  try { process.kill(JSON.parse(readFileSync(join(data, 'runtime/ptyhost.json'), 'utf8')).pid, 'SIGTERM') } catch {}
  await sleep(1200)
  // A scratch window can still be flushing its UI profile while it exits; that is not an update failure.
  if (passed) try { rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) } catch (e) { console.warn('Scratch cleanup left files behind:', scratch, e.code) }
}
