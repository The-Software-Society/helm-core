import { createReadStream, existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { TranscriptMessage, TranscriptSummary } from '@shared/types'
import { db } from '../db'
import { toTranscript } from '../db/mappers'
import { bus } from '../bus'
import { CLAUDE_PROJECTS, CODEX_HOME, QWEN_HOME, canonicalPath } from '../paths'
import { log, now } from '../util'
import { projectForPath, touchProject } from '../services/projects'

const MAX_TEXT = 4000
type Source = 'claude' | 'codex' | 'qwen'

interface Row {
  id: string
  source: Source
  agent_session_id: string
  project_path: string
  file_path: string
  title: string
  first_prompt: string
  model: string | null
  started_at: number
  updated_at: number
  message_count: number
  tokens_in: number
  tokens_out: number
  file_size: number
  file_mtime: number
  needs_reindex?: number
  codex_usage_cursor: string
}

const getRow = db.prepare('SELECT * FROM transcripts WHERE file_path = ?')
const upsertRow = db.prepare(
  `INSERT INTO transcripts(id, source, agent_session_id, project_path, file_path, title, first_prompt, model, started_at, updated_at, message_count, tokens_in, tokens_out, file_size, file_mtime, codex_usage_cursor)
   VALUES(@id, @source, @agent_session_id, @project_path, @file_path, @title, @first_prompt, @model, @started_at, @updated_at, @message_count, @tokens_in, @tokens_out, @file_size, @file_mtime, @codex_usage_cursor)
   ON CONFLICT(file_path) DO UPDATE SET agent_session_id=excluded.agent_session_id, project_path=excluded.project_path, title=excluded.title,
     first_prompt=excluded.first_prompt, model=excluded.model, updated_at=excluded.updated_at, message_count=excluded.message_count,
     tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out, file_size=excluded.file_size, file_mtime=excluded.file_mtime, codex_usage_cursor=excluded.codex_usage_cursor, needs_reindex=0`,
)
const insertFts = db.prepare('INSERT INTO transcript_fts(transcript_id, role, text, ts) VALUES(?, ?, ?, ?)')
const addUsage = db.prepare(
  `INSERT INTO usage(day, provider, model, transcript_id, tokens_in, tokens_out) VALUES(?, ?, ?, ?, ?, ?)
   ON CONFLICT(day, provider, model, transcript_id) DO UPDATE SET tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
)

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10)
const clean = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

function claudeText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n')
}

function isNoisePrompt(t: string) {
  return !t || t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')
}

/** Qwen messages carry Gemini-shaped `parts`; `thought: true` marks reasoning, which we don't index. */
function qwenText(message: any): string {
  const parts = message?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((p: any) => typeof p?.text === 'string' && p.thought !== true)
    .map((p: any) => p.text)
    .join('\n')
}

let codexTitles: Map<string, string> | null = null
function codexTitle(threadId: string) {
  if (!codexTitles) {
    codexTitles = new Map()
    const f = join(CODEX_HOME, 'session_index.jsonl')
    if (existsSync(f))
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        try {
          const d = JSON.parse(line)
          if (d.id && d.thread_name) codexTitles.set(d.id, d.thread_name)
        } catch {}
      }
  }
  return codexTitles.get(threadId) || ''
}

/** Stream only the bytes appended since the last pass; complete lines only. */
export async function indexFile(path: string, source: Source): Promise<boolean> {
  let st
  try {
    st = statSync(path)
  } catch {
    return false
  }
  const prev = getRow.get(path) as Row | undefined
  if (prev && !prev.needs_reindex && prev.file_size === st.size && prev.file_mtime === Math.floor(st.mtimeMs)) return false
  if (prev?.agent_session_id === '__skip__') return false
  const start = prev && !prev.needs_reindex && st.size >= prev.file_size ? prev.file_size : 0
  const row: Row = prev && start > 0
    ? { ...prev }
    : {
        id: prev?.id || `trn_${source}_${path.split('/').pop()!.replace('.jsonl', '').slice(-36)}`,
        source, agent_session_id: '', project_path: '', file_path: path, title: '', first_prompt: '', model: null,
        started_at: Math.floor(st.birthtimeMs || st.mtimeMs), updated_at: Math.floor(st.mtimeMs), message_count: 0,
        tokens_in: 0, tokens_out: 0, file_size: 0, file_mtime: 0, codex_usage_cursor: '{}',
      }

  let consumed = start
  const stream = createReadStream(path, { start, encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const seenMsg = new Set<string>()
  let skip = false
  const batch: (() => void)[] = []

  for await (const line of rl) {
    consumed += Buffer.byteLength(line, 'utf8') + 1
    if (!line) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      consumed -= Buffer.byteLength(line, 'utf8') + 1 // partial trailing line — retry next pass
      break
    }
    const ts = d.timestamp ? Date.parse(d.timestamp) : 0
    if (ts) row.updated_at = Math.max(row.updated_at, ts)

    if (source === 'claude') {
      if (d.sessionId && !row.agent_session_id) row.agent_session_id = d.sessionId
      if (d.cwd && !row.project_path) row.project_path = canonicalPath(d.cwd)
      if (d.type === 'summary' && d.summary) row.title = d.summary
      if (d.type === 'ai-title' && d.title) row.title = d.title
      if (d.type === 'user' && d.message?.role === 'user' && !d.isMeta) {
        const text = clean(claudeText(d.message.content))
        if (!isNoisePrompt(text)) {
          if (!row.first_prompt) row.first_prompt = oneLine(text).slice(0, 300)
          row.message_count++
          const id = row.id
          batch.push(() => insertFts.run(id, 'user', text.slice(0, MAX_TEXT), ts))
        }
      }
      if (d.type === 'assistant' && d.message) {
        const m = d.message
        if (m.model && m.model !== '<synthetic>') row.model = m.model
        const text = clean(claudeText(m.content))
        const mid = m.id || d.uuid
        if (m.usage && mid && !seenMsg.has(mid)) {
          seenMsg.add(mid)
          // Fresh input only — prompt-cache reads are cheap re-reads and would swamp the numbers.
          const tin = (m.usage.input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0)
          const tout = m.usage.output_tokens || 0
          row.tokens_in += tin
          row.tokens_out += tout
          const id = row.id, model = row.model || 'unknown'
          if (ts) batch.push(() => addUsage.run(day(ts), 'claude', model, id, tin, tout))
        }
        if (text) {
          row.message_count++
          const id = row.id
          batch.push(() => insertFts.run(id, 'assistant', text.slice(0, MAX_TEXT), ts))
        }
      }
    } else if (source === 'qwen') {
      if (d.sessionId && !row.agent_session_id) row.agent_session_id = d.sessionId
      if (d.cwd && !row.project_path) row.project_path = canonicalPath(d.cwd)
      if (d.model) row.model = d.model
      const ui = d.type === 'system' && d.subtype === 'ui_telemetry' ? d.systemPayload?.uiEvent : null
      if (ui && ui['event.name'] === 'qwen-code.api_response') {
        if (ui.model) row.model = ui.model
        // input_token_count includes cache reads, which are cheap re-reads and would swamp the numbers.
        const tin = Math.max(0, (ui.input_token_count || 0) - (ui.cached_content_token_count || 0))
        const tout = ui.output_token_count || 0
        row.tokens_in += tin
        row.tokens_out += tout
        const id = row.id, model = row.model || 'unknown'
        if (ts && (tin || tout)) batch.push(() => addUsage.run(day(ts), 'qwen', model, id, tin, tout))
      }
      const role = d.message?.role
      if (role === 'user' || role === 'model') {
        const text = clean(qwenText(d.message))
        if (text && role === 'user' && !isNoisePrompt(text)) {
          if (!row.first_prompt) row.first_prompt = oneLine(text).slice(0, 300)
          row.message_count++
          const id = row.id
          batch.push(() => insertFts.run(id, 'user', text.slice(0, MAX_TEXT), ts))
        } else if (text && role === 'model') {
          row.message_count++
          const id = row.id
          batch.push(() => insertFts.run(id, 'assistant', text.slice(0, MAX_TEXT), ts))
        }
      }
    } else {
      let p = d.payload || {}
      // Codex 0.153+ emits completed message items, rather than legacy user_message/agent_message events.
      // Read the UI events only: response_item mirrors them and would duplicate each message.
      if (d.type === 'event_msg' && p.type === 'item_completed') {
        const item = p.item || {}
        if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
          const message = (item.content || []).filter((c: any) => typeof c.text === 'string').map((c: any) => c.text).join('\n')
          p = { type: item.type === 'UserMessage' ? 'user_message' : 'agent_message', message }
        }
      }
      if (d.type === 'session_meta') {
        if (p.source?.subagent || p.thread_source === 'guardian_review') {
          skip = true
          break
        }
        row.agent_session_id = p.id || p.session_id || row.agent_session_id
        row.project_path = p.cwd ? canonicalPath(p.cwd) : row.project_path
        if (p.timestamp) row.started_at = Date.parse(p.timestamp)
      }
      if (d.type === 'turn_context' && p.model) row.model = p.model
      if (d.type === 'event_msg') {
        if (p.type === 'user_message' && typeof p.message === 'string') {
          const text = clean(p.message)
          if (!isNoisePrompt(text)) {
            if (!row.first_prompt) row.first_prompt = oneLine(text).slice(0, 300)
            row.message_count++
            const id = row.id
            batch.push(() => insertFts.run(id, 'user', text.slice(0, MAX_TEXT), ts))
          }
        } else if (p.type === 'agent_message' && typeof p.message === 'string') {
          row.message_count++
          const id = row.id, text = clean(p.message)
          batch.push(() => insertFts.run(id, 'assistant', text.slice(0, MAX_TEXT), ts))
        } else if (p.type === 'token_count' && p.info?.total_token_usage) {
          const u = p.info.total_token_usage
          const previous = JSON.parse(row.codex_usage_cursor || '{}') as { input?: number; cached?: number; output?: number }
          const input = u.input_tokens || 0, cached = u.cached_input_tokens || 0
          const tin = Math.max(0, input - cached)
          // output_tokens includes reasoning; counters restart when the CLI resumes a conversation.
          const tout = u.output_tokens || 0
          const reset = input < (previous.input || 0) || tout < (previous.output || 0)
          const din = Math.max(0, tin - (reset ? 0 : Math.max(0, (previous.input || 0) - (previous.cached || 0))))
          const dout = Math.max(0, tout - (reset ? 0 : previous.output || 0))
          row.tokens_in += din
          row.tokens_out += dout
          row.codex_usage_cursor = JSON.stringify({ input, cached, output: tout })
          const id = row.id, model = row.model || 'unknown'
          if (ts && (din || dout)) batch.push(() => addUsage.run(day(ts), 'codex', model, id, din, dout))
        }
      }
    }
  }
  rl.close()
  stream.destroy()

  if (skip) {
    upsertRow.run({ ...row, agent_session_id: '__skip__', project_path: '', file_size: st.size, file_mtime: Math.floor(st.mtimeMs) })
    return false
  }
  if (source === 'codex') row.title = codexTitle(row.agent_session_id) || row.title
  if (!row.title) row.title = row.first_prompt.slice(0, 80)
  row.file_size = consumed
  row.file_mtime = consumed >= st.size ? Math.floor(st.mtimeMs) : 0
  if (!row.project_path || !row.agent_session_id) return false
  // Keep the previous searchable history if a replacement source is incomplete or invalid.
  if (prev && start === 0 && consumed < st.size) return false
  db.transaction(() => {
    if (prev && start === 0) {
      db.prepare('DELETE FROM transcript_fts WHERE transcript_id = ?').run(prev.id)
      db.prepare('DELETE FROM usage WHERE transcript_id = ?').run(prev.id)
    }
    upsertRow.run(row)
    for (const fn of batch) fn()
  })()
  const project = projectForPath(row.project_path)
  if (project) touchProject(project.id, row.updated_at)
  return true
}

function listClaudeFiles(): string[] {
  if (!existsSync(CLAUDE_PROJECTS)) return []
  const out: string[] = []
  for (const dir of readdirSync(CLAUDE_PROJECTS)) {
    const full = join(CLAUDE_PROJECTS, dir)
    try {
      for (const f of readdirSync(full)) if (f.endsWith('.jsonl')) out.push(join(full, f))
    } catch {}
  }
  return out
}

function listCodexFiles(): string[] {
  const root = join(CODEX_HOME, 'sessions')
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(root)
  return out
}

function listQwenFiles(): string[] {
  const root = join(QWEN_HOME, 'projects')
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const dir of readdirSync(root)) {
    const chats = join(root, dir, 'chats')
    try {
      for (const f of readdirSync(chats)) if (f.endsWith('.jsonl')) out.push(join(chats, f))
    } catch {}
  }
  return out
}

let scanning = false
export const indexState = { lastScanAt: 0, files: 0, running: false }

export async function scanAll() {
  if (scanning) return
  scanning = true
  indexState.running = true
  const t0 = now()
  let changed = 0
  try {
    codexTitles = null
    // Canonicalize cached paths without removing any conversations or requiring source files.
    for (const row of db.prepare("SELECT id, project_path FROM transcripts WHERE project_path != ''").all() as { id: string; project_path: string }[]) {
      const canonical = canonicalPath(row.project_path)
      if (canonical !== row.project_path) db.prepare('UPDATE transcripts SET project_path = ? WHERE id = ?').run(canonical, row.id)
    }
    const files: [string, Source][] = [
      ...listClaudeFiles().map((f) => [f, 'claude'] as [string, Source]),
      ...listCodexFiles().map((f) => [f, 'codex'] as [string, Source]),
      ...listQwenFiles().map((f) => [f, 'qwen'] as [string, Source]),
    ]
    // newest first so the UI fills with recent work quickly
    files.sort((a, b) => safeMtime(b[0]) - safeMtime(a[0]))
    indexState.files = files.length
    for (const [f, src] of files) {
      try {
        if (await indexFile(f, src)) changed++
      } catch (e) {
        log('index failed', f, e)
      }
      await new Promise((r) => setImmediate(r))
    }
  } finally {
    scanning = false
    indexState.running = false
    indexState.lastScanAt = now()
  }
  if (changed) bus.invalidate('transcripts', 'projects', 'suggestions', 'usage')
  log(`transcript scan: ${changed} changed in ${now() - t0}ms`)
}

function safeMtime(f: string) {
  try {
    return statSync(f).mtimeMs
  } catch {
    return 0
  }
}

export function startWatching() {
  const pending = new Map<string, NodeJS.Timeout>()
  const queue = (path: string, src: Source) => {
    if (!path.endsWith('.jsonl') || path.includes('/subagents/')) return
    clearTimeout(pending.get(path))
    pending.set(
      path,
      setTimeout(async () => {
        pending.delete(path)
        if (src === 'codex') codexTitles = null
        if (await indexFile(path, src).catch(() => false)) bus.invalidate('transcripts')
      }, 2000),
    )
  }
  const w = (root: string, src: Source) => {
    if (!existsSync(root)) return
    try {
      watch(root, { recursive: true }, (_e, f) => f && queue(join(root, f.toString()), src))
    } catch (e) {
      log('watch failed', root, e)
    }
  }
  w(CLAUDE_PROJECTS, 'claude')
  w(join(CODEX_HOME, 'sessions'), 'codex')
  w(join(QWEN_HOME, 'projects'), 'qwen')
  setInterval(() => void scanAll(), 5 * 60_000)
}

// ---------- queries ----------
export function listTranscripts(opts: { projectPath?: string; limit?: number } = {}): TranscriptSummary[] {
  opts = { ...opts, projectPath: opts.projectPath ? canonicalPath(opts.projectPath) : undefined }
  const limit = opts.limit || 100
  if (opts.projectPath)
    return db
      .prepare(
        `SELECT * FROM transcripts WHERE agent_session_id != '__skip__' AND (project_path = ? OR project_path LIKE ? || '/%' OR project_path LIKE '%/.helm/worktrees/%')
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(opts.projectPath, opts.projectPath, limit)
      .map(toTranscript)
      .filter((t) => !t.projectPath.includes('/.helm/worktrees/') || worktreeBelongs(t.projectPath, opts.projectPath!))
  return db.prepare(`SELECT * FROM transcripts WHERE agent_session_id != '__skip__' ORDER BY updated_at DESC LIMIT ?`).all(limit).map(toTranscript)
}

function worktreeBelongs(wt: string, projectPath: string) {
  const r = db.prepare('SELECT 1 FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.worktree = ? AND p.id = ?').get(wt, projectForPath(projectPath)?.id || '')
  return !!r
}

export function searchTranscripts(q: string, projectPath?: string, limit = 40) {
  if (projectPath) projectPath = canonicalPath(projectPath)
  const query = q
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '')}"*`)
    .join(' ')
  if (!query) return []
  return db
    .prepare(
      `SELECT t.*, snippet(transcript_fts, 2, '«', '»', '…', 18) AS snip, f.role AS hit_role, f.ts AS hit_ts
       FROM transcript_fts f JOIN transcripts t ON t.id = f.transcript_id
       WHERE transcript_fts MATCH ? ${projectPath ? `AND (t.project_path = ? OR t.project_path LIKE ? || '/%')` : ''}
       ORDER BY rank LIMIT ?`,
    )
    .all(...(projectPath ? [query, projectPath, projectPath, limit] : [query, limit]))
    .map((r: any) => ({ transcript: toTranscript(r), snippet: r.snip as string, role: r.hit_role as string, ts: r.hit_ts as number }))
}

export function transcriptMessages(tid: string, limit = 400): TranscriptMessage[] {
  return (db.prepare('SELECT role, text, ts FROM transcript_fts WHERE transcript_id = ? ORDER BY rowid DESC LIMIT ?').all(tid, limit) as any[])
    .reverse()
    .map((r) => ({ role: r.role, text: r.text, ts: r.ts }))
}

const codexConversationCache = new Map<string, { cursor: number; messages: TranscriptMessage[] }>()

/** Read complete Codex messages, preserving Markdown indentation and text beyond the search index limit. */
export async function codexConversation(agentSessionId: string): Promise<TranscriptMessage[]> {
  const row = db.prepare('SELECT file_path FROM transcripts WHERE source = ? AND agent_session_id = ? ORDER BY updated_at DESC LIMIT 1').get('codex', agentSessionId) as { file_path: string } | undefined
  const path = row?.file_path || listCodexFiles().find((f) => f.endsWith(`${agentSessionId}.jsonl`))
  if (!path) return []
  let size: number
  try { size = statSync(path).size } catch { return [] }
  let cached = codexConversationCache.get(path)
  if (!cached || size < cached.cursor) {
    cached = { cursor: 0, messages: [] }
    codexConversationCache.set(path, cached)
  }
  if (size === cached.cursor) return cached.messages.slice()
  const stream = createReadStream(path, { start: cached.cursor, encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let cursor = cached.cursor
  for await (const line of rl) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1
    if (!line) { cursor += bytes; continue }
    let d: any
    try { d = JSON.parse(line) } catch { break }
    cursor += bytes
    if (d.type !== 'event_msg') continue // response_item mirrors completed UI messages
    const p = d.payload || {}
    const item = p.type === 'item_completed' ? p.item : null
    const role = item?.type === 'UserMessage' || p.type === 'user_message' ? 'user'
      : item?.type === 'AgentMessage' || p.type === 'agent_message' ? 'assistant' : null
    if (!role) continue
    const raw = item ? (item.content || []).filter((c: any) => typeof c.text === 'string').map((c: any) => c.text).join('\n') : p.message
    if (typeof raw !== 'string' || !raw.trim() || (role === 'user' && isNoisePrompt(raw))) continue
    cached.messages.push({ role, text: raw.trim(), ts: d.timestamp ? Date.parse(d.timestamp) : 0 })
  }
  rl.close()
  stream.destroy()
  cached.cursor = Math.min(cursor, size)
  return cached.messages.slice()
}

export function getTranscript(tid: string): TranscriptSummary | null {
  const r = db.prepare('SELECT * FROM transcripts WHERE id = ?').get(tid)
  return r ? toTranscript(r) : null
}

export function usageByDay(days = 30) {
  const since = new Date(now() - days * 86_400_000).toISOString().slice(0, 10)
  return db
    .prepare(
      `SELECT day, provider, model, sum(tokens_in) tokensIn, sum(tokens_out) tokensOut, count(DISTINCT transcript_id) sessions
       FROM usage WHERE day >= ? GROUP BY day, provider, model ORDER BY day`,
    )
    .all(since)
}
