// helm-ptyhost: owns every terminal so hubd can restart without killing them.
// Deliberately small and dependency-light — it rarely changes, because changing it means a disruptive restart.
// One client at a time (the current hubd); a newer connection replaces an older one.
import net from 'node:net'
import { appendFileSync, chmodSync, unlinkSync, writeFileSync } from 'node:fs'
import * as pty from 'node-pty'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { PTYHOST_PROTOCOL, lineReader, type FromHost, type HostTerm, type ToHost } from './protocol'

const SOCK = process.env.HELM_PTYHOST_SOCK || ''
const TOKEN = process.env.HELM_PTYHOST_TOKEN || ''
const LOG = process.env.HELM_PTYHOST_LOG || ''
const INFO = process.env.HELM_PTYHOST_INFO || ''
const SCROLLBACK = 5000
// With nothing running and no hubd connected for this long, the host exits; hubd starts a new one when needed.
const IDLE_EXIT_MS = 10 * 60_000
// A hubd that stops reading must not grow host memory without bound: drop it, it resyncs from snapshots.
const MAX_BUFFERED = 32 * 1024 * 1024

process.title = 'helm-core-ptyhost'
const log = (...a: unknown[]) => {
  if (!LOG) return
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`)
  } catch {}
}

interface Term {
  id: string
  proc: pty.IPty
  mirror: Terminal
  serializer: SerializeAddon
  cols: number
  rows: number
  exit: number | null
  final: string
}

const terms = new Map<string, Term>()
let client: net.Socket | null = null
let idleSince = Date.now()

function send(m: FromHost) {
  if (!client || client.destroyed) return
  client.write(JSON.stringify(m) + '\n')
  if (client.writableLength > MAX_BUFFERED) {
    log('client not reading; dropping it')
    client.destroy()
  }
}

const listTerms = (): HostTerm[] => [...terms.values()].map((t) => ({ id: t.id, pid: t.proc.pid, cols: t.cols, rows: t.rows, exit: t.exit }))

function spawn(m: Extract<ToHost, { t: 'spawn' }>) {
  const prev = terms.get(m.id)
  if (prev && prev.exit === null) return send({ t: 'spawn-failed', id: m.id, error: 'A terminal with this id is still running' })
  if (prev) terms.delete(m.id)
  let proc: pty.IPty
  try {
    proc = pty.spawn(m.file, m.args, { name: 'xterm-256color', cols: m.cols, rows: m.rows, cwd: m.cwd, env: m.env })
  } catch (e) {
    return send({ t: 'spawn-failed', id: m.id, error: e instanceof Error ? e.message : String(e) })
  }
  const mirror = new Terminal({ cols: m.cols, rows: m.rows, scrollback: SCROLLBACK, allowProposedApi: true })
  const serializer = new SerializeAddon()
  mirror.loadAddon(serializer)
  const term: Term = { id: m.id, proc, mirror, serializer, cols: m.cols, rows: m.rows, exit: null, final: '' }
  terms.set(m.id, term)
  proc.onData((data) => {
    mirror.write(data)
    send({ t: 'data', id: m.id, data })
  })
  proc.onExit(({ exitCode }) => {
    // Let the mirror finish parsing the last output before freezing the final screen.
    mirror.write('', () => {
      term.final = serializer.serialize()
      term.exit = exitCode
      mirror.dispose()
      send({ t: 'exit', id: m.id, code: exitCode })
    })
  })
  log(`spawn ${m.id} pid=${proc.pid} ${m.file}`)
  send({ t: 'spawned', id: m.id, pid: proc.pid })
}

function handle(sock: net.Socket, m: ToHost) {
  if (m.t !== 'hello' && sock !== client) return
  switch (m.t) {
    case 'hello': {
      if (m.token !== TOKEN) {
        log('rejected client with a wrong token')
        return sock.destroy()
      }
      if (client && client !== sock) client.destroy()
      client = sock
      log(`client connected (protocol ${m.protocol}), ${terms.size} terminals`)
      return send({ t: 'hello', pid: process.pid, protocol: PTYHOST_PROTOCOL, terms: listTerms() })
    }
    case 'spawn':
      return spawn(m)
    case 'attach': {
      const t = terms.get(m.id)
      // Snapshot and subscription are the same tick: nothing is lost or duplicated between them.
      return send({ t: 'snapshot', rid: m.rid, id: m.id, data: !t ? '' : t.exit === null ? t.serializer.serialize() : t.final, exit: t ? t.exit : -1 })
    }
    case 'write':
      return void terms.get(m.id)?.proc.write(m.data)
    case 'resize': {
      const t = terms.get(m.id)
      if (!t || t.exit !== null || m.cols < 2 || m.rows < 2) return
      try {
        t.proc.resize(m.cols, m.rows)
        t.mirror.resize(m.cols, m.rows)
        t.cols = m.cols
        t.rows = m.rows
      } catch {}
      return
    }
    case 'kill': {
      const t = terms.get(m.id)
      if (t && t.exit === null) {
        try {
          t.proc.kill(m.signal)
        } catch {}
      }
      return
    }
    case 'reap': {
      const t = terms.get(m.id)
      if (t && t.exit !== null) terms.delete(m.id)
      return
    }
  }
}

const server = net.createServer((sock) => {
  sock.setNoDelay(true)
  sock.on('data', lineReader((m) => handle(sock, m)))
  sock.on('error', () => {})
  sock.on('close', () => {
    if (sock === client) {
      client = null
      idleSince = Date.now()
      log('client disconnected; terminals keep running')
    }
  })
})

function listen() {
  server.once('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EADDRINUSE') throw e
    // A live host already owns the socket: this one is redundant. A stale file is reclaimed.
    const probe = net.connect(SOCK)
    probe.once('connect', () => {
      probe.destroy()
      log('another host is already running; exiting')
      process.exit(0)
    })
    probe.once('error', () => {
      try {
        unlinkSync(SOCK)
      } catch {}
      server.listen(SOCK, ready)
    })
  })
  server.listen(SOCK, ready)
}

function ready() {
  try {
    chmodSync(SOCK, 0o600)
  } catch {}
  if (INFO) {
    try {
      writeFileSync(INFO, JSON.stringify({ pid: process.pid, sock: SOCK, protocol: PTYHOST_PROTOCOL, startedAt: Date.now() }), { mode: 0o600 })
    } catch {}
  }
  log(`helm-ptyhost pid=${process.pid} listening`)
}

setInterval(() => {
  const running = [...terms.values()].some((t) => t.exit === null)
  if (client || running) return void (idleSince = Date.now())
  if (Date.now() - idleSince > IDLE_EXIT_MS) {
    log('idle; exiting')
    process.exit(0)
  }
}, 30_000).unref()

// The host is detached from hubd; only an explicit signal stops it, and then its terminals end with it.
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => {
    log(`${sig}; ending ${terms.size} terminals`)
    for (const t of terms.values()) {
      try {
        if (t.exit === null) t.proc.kill()
      } catch {}
    }
    process.exit(0)
  })
process.on('SIGHUP', () => log('SIGHUP ignored'))
process.on('uncaughtException', (e) => log('uncaught', e))

if (!SOCK || !TOKEN) {
  log('missing socket or token; exiting')
  process.exit(1)
}
listen()
