// hubd's side of helm-ptyhost. Terminals look like node-pty processes to the session manager, but they live in the
// host, so restarting hubd only detaches from them. Messages queue while (re)connecting, so the API stays synchronous.
import net from 'node:net'
import { spawn as spawnProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { DATA_DIR, RUNTIME_DIR } from '../paths'
import { log } from '../util'
import { PTYHOST_PROTOCOL, hostSocketPath, hostToken, lineReader, type FromHost, type HostTerm, type ToHost } from './protocol'

/** The subset of node-pty the session manager uses. */
export interface Proc {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface SpawnOpts {
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export const HOST_INFO = join(RUNTIME_DIR, 'ptyhost.json')
/** Exit code reported when the terminal host itself went away (the terminal may be resumable, not failed). */
export const HOST_LOST = -1000

// ---------- in-process backend (tests, or when the host bundle is missing) ----------

function spawnLocal(file: string, args: string[], o: SpawnOpts): Proc {
  return pty.spawn(file, args, { name: 'xterm-256color', ...o })
}

// ---------- host backend ----------

class HostProc implements Proc {
  pid = 0
  dataCbs: ((d: string) => void)[] = []
  exitCbs: ((e: { exitCode: number }) => void)[] = []
  exited = false
  constructor(readonly id: string) {}
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb)
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb)
  }
  write(data: string) {
    out({ t: 'write', id: this.id, data })
  }
  resize(cols: number, rows: number) {
    out({ t: 'resize', id: this.id, cols, rows })
  }
  kill(signal?: string) {
    out({ t: 'kill', id: this.id, ...(signal ? { signal } : {}) })
  }
  emitData(d: string) {
    for (const cb of this.dataCbs) cb(d)
  }
  emitExit(code: number) {
    if (this.exited) return
    this.exited = true
    for (const cb of this.exitCbs) cb({ exitCode: code })
    procs.delete(this.id)
    if (connected) out({ t: 'reap', id: this.id })
  }
}

let hostScript: string | null = null
let token = ''
let sock: net.Socket | null = null
let connected = false
let connecting: Promise<FromHost & { t: 'hello' }> | null = null
let queue: string[] = []
let rid = 0
// Sockets hubd let go of on purpose. Per socket, not a flag: a detached socket's close can land after a new connection.
const detached = new WeakSet<net.Socket>()
const procs = new Map<string, HostProc>()
const pending = new Map<number, (m: FromHost & { t: 'snapshot' }) => void>()

/** Choose the backend. Host mode needs the built helm-ptyhost bundle next to hubd. */
export function configurePtyHost(opts: { script?: string | null; daemonToken: string }) {
  const script = opts.script === undefined ? join(__dirname, 'ptyhost.js') : opts.script
  hostScript = script && !process.env.HELM_PTY_INPROC && existsSync(script) ? script : null
  token = hostToken(opts.daemonToken)
}

export const usingHost = () => !!hostScript

function out(m: ToHost) {
  const line = JSON.stringify(m) + '\n'
  if (connected && sock) sock.write(line)
  else {
    queue.push(line)
    void connect().catch((e) => {
      log('ptyhost connect failed', e)
      // Nothing queued can run: fail those terminals visibly rather than leaving them "starting" forever.
      queue = []
      for (const p of [...procs.values()]) {
        p.emitData(`\r\n\x1b[31mThe terminal host is unavailable: ${e instanceof Error ? e.message : e}\x1b[0m\r\n`)
        p.emitExit(127)
      }
    })
  }
}

function onMessage(m: FromHost) {
  switch (m.t) {
    case 'spawned': {
      const p = procs.get(m.id)
      if (p) p.pid = m.pid
      return
    }
    case 'spawn-failed': {
      const p = procs.get(m.id)
      if (p) {
        p.emitData(`\r\n\x1b[31mCould not start: ${m.error}\x1b[0m\r\n`)
        p.emitExit(127)
      }
      return
    }
    case 'data':
      return void procs.get(m.id)?.emitData(m.data)
    case 'exit':
      return void procs.get(m.id)?.emitExit(m.code)
    case 'snapshot': {
      const cb = pending.get(m.rid)
      pending.delete(m.rid)
      return void cb?.(m)
    }
  }
}

function startHost() {
  const child = spawnProcess(process.execPath, [hostScript!], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HELM_PTYHOST_SOCK: hostSocketPath(DATA_DIR),
      HELM_PTYHOST_TOKEN: token,
      HELM_PTYHOST_LOG: join(DATA_DIR, 'ptyhost.log'),
      HELM_PTYHOST_INFO: HOST_INFO,
    },
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', (e) => log('ptyhost spawn failed', e))
  child.unref()
  log(`started helm-ptyhost pid=${child.pid}`)
}

function dial(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(hostSocketPath(DATA_DIR))
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

/** Connect (starting the host if none is running). Resolves with the host's list of terminals. */
export function connect(): Promise<FromHost & { t: 'hello' }> {
  if (!hostScript) return Promise.reject(new Error('Terminal host is not in use'))
  if (connecting) return connecting
  connecting = (async () => {
    let s: net.Socket | null = null
    let started = false
    for (let i = 0; i < 50 && !s; i++) {
      try {
        s = await dial()
      } catch {
        if (!started) {
          startHost()
          started = true
        }
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    if (!s) throw new Error('Terminal host did not start. See ptyhost.log')
    const hello = await new Promise<FromHost & { t: 'hello' }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Terminal host did not answer')), 5000)
      let first = true
      s!.on(
        'data',
        lineReader((m: FromHost) => {
          if (first && m.t === 'hello') {
            first = false
            clearTimeout(timer)
            return resolve(m)
          }
          onMessage(m)
        }),
      )
      s!.once('close', () => reject(new Error('Terminal host closed the connection')))
      s!.write(JSON.stringify({ t: 'hello', token, protocol: PTYHOST_PROTOCOL } satisfies ToHost) + '\n')
    })
    sock = s
    connected = true
    s.on('error', () => {})
    s.on('close', () => {
      if (detached.has(s)) return
      connected = false
      sock = null
      // The host is gone, and its terminals with it.
      log('lost the terminal host; its terminals have ended')
      for (const p of [...procs.values()]) p.emitExit(HOST_LOST)
      for (const cb of pending.values()) cb({ t: 'snapshot', rid: 0, id: '', data: '', exit: HOST_LOST })
      pending.clear()
    })
    const q = queue
    queue = []
    for (const line of q) s.write(line)
    log(`connected to helm-ptyhost pid=${hello.pid} with ${hello.terms.length} terminals`)
    return hello
  })().finally(() => (connecting = null))
  return connecting
}

/** Start a terminal. Synchronous like node-pty; with the host, the pid arrives shortly after. */
export function spawnTerminal(id: string, file: string, args: string[], o: SpawnOpts): Proc {
  if (!hostScript) return spawnLocal(file, args, o)
  const p = new HostProc(id)
  procs.set(id, p)
  out({ t: 'spawn', id, file, args, ...o })
  return p
}

/** Reattach to a terminal that kept running in the host: its current screen, then its live stream. */
export async function adoptTerminal(t: HostTerm): Promise<{ proc: Proc; screen: string; exit: number | null }> {
  const p = new HostProc(t.id)
  p.pid = t.pid
  procs.set(t.id, p)
  const r = ++rid
  const snap = await new Promise<FromHost & { t: 'snapshot' }>((resolve) => {
    pending.set(r, resolve)
    out({ t: 'attach', id: t.id, rid: r })
  })
  return { proc: p, screen: snap.data, exit: snap.exit }
}

/** Forget an adopted terminal that had already ended (its exit is recorded by the caller). */
export function releaseTerminal(id: string) {
  procs.delete(id)
  if (connected) out({ t: 'reap', id })
}

/** The host could not be reached: run terminals in-process from now on. */
export function disableHost() {
  hostScript = null
}

/** End a terminal hubd no longer tracks and forget it. */
export function discardTerminal(id: string) {
  out({ t: 'kill', id })
  out({ t: 'reap', id })
}

/** hubd is shutting down: leave every terminal running in the host. */
export function detachHost() {
  procs.clear()
  if (!sock) return
  detached.add(sock)
  try {
    sock.end()
  } catch {}
  sock = null
  connected = false
}

export function hostInfo(): { pid: number; sock: string } | null {
  try {
    return JSON.parse(readFileSync(HOST_INFO, 'utf8'))
  } catch {
    return null
  }
}
