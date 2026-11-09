import http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientEvent, ServerEvent } from '@shared/types'
import { bus } from './bus'
import { runtime } from './runtime'
import { log } from './util'
import { sessionToken, tokenMatches } from './auth'
import * as pty from './pty/manager'

export type Handler = (ctx: { params: Record<string, string>; query: URLSearchParams; body: any; sessionId: string }) => unknown | Promise<unknown>

interface Route {
  method: string
  re: RegExp
  keys: string[]
  handler: Handler
  isPublic?: boolean
  html?: boolean
}

const routes: Route[] = []

export function route(method: string, pattern: string, handler: Handler, opts: { isPublic?: boolean; html?: boolean } = {}) {
  const keys: string[] = []
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$')
  routes.push({ method, re, keys, handler, ...opts })
}

/** Unauthenticated GET that returns HTML — only for browser redirects like OAuth callbacks. */
export const publicPage = (p: string, h: Handler) => route('GET', p, h, { isPublic: true, html: true })

export const get = (p: string, h: Handler) => route('GET', p, h)
export const post = (p: string, h: Handler) => route('POST', p, h)
export const patch = (p: string, h: Handler) => route('PATCH', p, h)
export const del = (p: string, h: Handler) => route('DELETE', p, h)

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain', '.log': 'text/plain', '.json': 'application/json' }

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      if (!data) return resolve(undefined)
      try {
        resolve(JSON.parse(data))
      } catch {
        resolve(data)
      }
    })
  })
}

function authed(req: http.IncomingMessage, url: URL) {
  const h = req.headers.authorization
  return tokenMatches(h?.replace(/^Bearer /, '') || url.searchParams.get('token') || '', runtime.token)
}

let activeServer: http.Server | null = null
let activeSockets: WebSocketServer | null = null

export async function stopServer() {
  for (const ws of activeSockets?.clients || []) ws.terminate()
  activeSockets?.close()
  const server = activeServer
  activeServer = null
  if (server) await new Promise<void>((resolve, reject) => {
    server.close((e) => e ? reject(e) : resolve())
    server.closeAllConnections()
  })
}

export function startServer(preferredPort: number): Promise<number> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Helm-Session')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') return res.end()
    if (url.pathname === '/health') return res.end(JSON.stringify({ ok: true, pid: process.pid }))
    const publicRoute = routes.find((x) => x.isPublic && x.method === req.method && x.re.test(url.pathname))
    if (publicRoute) {
      const m = url.pathname.match(publicRoute.re)!
      const params = Object.fromEntries(publicRoute.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
      try {
        const out = await publicRoute.handler({ params, query: url.searchParams, body: undefined, sessionId: '' })
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        return res.end(String(out ?? ''))
      } catch (e) {
        res.statusCode = 500
        return res.end(`<p>${e instanceof Error ? e.message : 'Error'}</p>`)
      }
    }
    const isUi = authed(req, url)
    const hookSid = url.pathname.match(/^\/hooks\/(claude|codex|qwen)\/([^/]+)$/)?.[2]
    const sid = hookSid || String(req.headers['x-helm-session'] || '')
    const agent = sid ? pty.getSession(sid) : null
    const isAgent = !!agent && !agent.archived && tokenMatches(req.headers.authorization?.replace(/^Bearer /, '') || '', sessionToken(sid))
    const agentRoute = (req.method === 'POST' && !!hookSid && agent?.provider === url.pathname.split('/')[2]) ||
      (req.method === 'GET' && url.pathname === '/mcp-api/context') ||
      (req.method === 'POST' && url.pathname.startsWith('/mcp-api/call/'))
    if (!isUi && !(isAgent && agentRoute)) {
      res.statusCode = 401
      return res.end('unauthorized')
    }
    // raw file streaming (evidence images) — only files registered as evidence are served
    if (url.pathname === '/file') {
      const p = url.searchParams.get('path') || ''
      const { isServableFile } = await import('./files')
      if (!isServableFile(p) || !existsSync(p) || !statSync(p).isFile()) {
        res.statusCode = 404
        return res.end()
      }
      res.setHeader('Content-Type', MIME[extname(p).toLowerCase()] || 'application/octet-stream')
      return createReadStream(p).pipe(res)
    }
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname))
    if (!r) {
      res.statusCode = 404
      return res.end('not found')
    }
    const m = url.pathname.match(r.re)!
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
    try {
      const body = await readBody(req)
      const out = await r.handler({ params, query: url.searchParams, body, sessionId: isAgent ? sid : String(req.headers['x-helm-session'] || '') })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(out ?? null))
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      if (status >= 500) log(`route ${req.method} ${url.pathname} failed`, e)
      res.statusCode = status
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    }
  })

  // ---- WebSocket: event fan-out + PTY streaming ----
  activeServer = server
  const wss = new WebSocketServer({ noServer: true })
  activeSockets = wss
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname !== '/ws' || !authed(req, url)) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
  })

  wss.on('connection', (ws: WebSocket) => {
    const attached = new Set<string>()
    const send = (e: ServerEvent) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(e))
    const onEvent = (e: ServerEvent) => {
      if ((e.t === 'pty.data' || e.t === 'pty.exit') && !attached.has(e.sessionId)) return
      send(e)
    }
    bus.on('event', onEvent)
    ws.on('message', (raw) => {
      let msg: ClientEvent
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      switch (msg.t) {
        case 'pty.attach':
          attached.add(msg.sessionId)
          ws.send(JSON.stringify({ t: 'pty.snapshot', sessionId: msg.sessionId, data: pty.snapshot(msg.sessionId), live: pty.isLive(msg.sessionId) }))
          break
        case 'pty.detach':
          attached.delete(msg.sessionId)
          break
        case 'pty.input':
          pty.write(msg.sessionId, msg.data)
          break
        case 'pty.resize':
          pty.resize(msg.sessionId, msg.cols, msg.rows)
          break
      }
    })
    ws.on('close', () => bus.off('event', onEvent))
  })

  return new Promise((resolve, reject) => {
    let port = preferredPort
    const tryListen = () => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && port < preferredPort + 20) {
          port++
          tryListen()
        } else reject(e)
      })
      server.listen(port, '127.0.0.1', () => resolve((server.address() as import('node:net').AddressInfo).port))
    }
    tryListen()
  })
}
