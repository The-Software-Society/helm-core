import type { ClientEvent, ServerEvent } from '@shared/types'
import type { ElectronSpeechAPI } from 'electron-native-speech/preload'

export interface Connection {
  url: string
  token: string
  build: string
  channel: string
  expectedBuild: string
}

declare global {
  interface Window {
    helm: {
      connection(): Promise<Connection>
      uiReady(): Promise<void>
      restartDaemon(): Promise<void>
      pickFolder(): Promise<string | null>
      openExternal(url: string): Promise<void>
      reveal(path: string): Promise<void>
      openPath(path: string): Promise<string>
      copy(text: string): Promise<void>
      home: string
      statPaths(paths: string[]): Promise<{ path: string; exists: boolean; dir: boolean; size: number; mtime: number }[]>
      readText(path: string): Promise<{ text: string; binary: boolean; truncated: boolean; size: number }>
      copyImage(path: string): Promise<boolean>
      copyFile(path: string): Promise<void>
      quickLook(path: string): Promise<void>
      pathForFile(file: File): string
      pickFiles(): Promise<string[]>
      saveAttachment(name: string, bytes: ArrayBuffer): Promise<string>
      setBadge(n: number): void
      onCommand(cb: (cmd: string) => void): () => void
      onDaemonRestarted(cb: () => void): () => void
    }
    electronSpeech: ElectronSpeechAPI
  }
}

let conn: Connection | null = null

export async function connect(): Promise<Connection> {
  conn = await window.helm.connection()
  return conn
}

export function connection() {
  return conn
}

export function fileUrl(path: string) {
  return `${conn!.url}/file?path=${encodeURIComponent(path)}&token=${conn!.token}`
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!conn) await connect()
  const res = await fetch(`${conn!.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${conn!.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(data?.error || res.statusText)
  return data as T
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
}

// ───────── WebSocket: server events + PTY streams ─────────
type Listener = (e: ServerEvent) => void
type PtySink = { onData(d: string): void; onSnapshot(d: string, live: boolean): void; onExit(code: number | null): void }

const listeners = new Set<Listener>()
const sinks = new Map<string, PtySink>()
let ws: WebSocket | null = null
let backoff = 500
let connectedCb: ((up: boolean) => void) | null = null

export function onConnectionChange(cb: (up: boolean) => void) {
  connectedCb = cb
}

export function openSocket() {
  if (!conn) return
  const url = conn.url.replace('http', 'ws') + `/ws?token=${conn.token}`
  ws = new WebSocket(url)
  ws.onopen = () => {
    backoff = 500
    connectedCb?.(true)
    for (const sid of sinks.keys()) send({ t: 'pty.attach', sessionId: sid })
  }
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data) as ServerEvent | { t: 'pty.snapshot'; sessionId: string; data: string; live: boolean }
    if (e.t === 'pty.data') return sinks.get(e.sessionId)?.onData(e.data)
    if (e.t === 'pty.snapshot') return sinks.get(e.sessionId)?.onSnapshot(e.data, e.live)
    if (e.t === 'pty.exit') sinks.get(e.sessionId)?.onExit(e.code)
    for (const l of listeners) l(e as ServerEvent)
  }
  ws.onclose = () => {
    connectedCb?.(false)
    setTimeout(async () => {
      try {
        await connect()
      } catch {}
      openSocket()
    }, backoff)
    backoff = Math.min(backoff * 2, 8000)
  }
}

export function send(e: ClientEvent) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e))
}

export function subscribe(l: Listener) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function attachPty(sessionId: string, sink: PtySink) {
  sinks.set(sessionId, sink)
  send({ t: 'pty.attach', sessionId })
  return () => {
    sinks.delete(sessionId)
    send({ t: 'pty.detach', sessionId })
  }
}
