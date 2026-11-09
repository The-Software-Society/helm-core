import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { db } from '../db'
import { now, log } from '../util'
import { getSession, patchSession, setStatus } from '../pty/manager'
import { userEditContext } from '../userEdits'

const DEFAULT_NAME = /^(Claude|Codex|Qwen|Shell) \d+$/

function recordEvent(sid: string, event: string, payload: unknown) {
  const raw = JSON.stringify(payload)
  const stored = raw.length <= 4000 ? raw : JSON.stringify({ truncated: true, preview: raw.slice(0, 1500) })
  db.prepare('INSERT INTO session_events(session_id, event, payload, created_at) VALUES(?, ?, ?, ?)').run(
    sid,
    event,
    stored,
    now(),
  )
}

function clip(s: unknown, n = 160) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : ''
}

/** Last assistant text from a Claude transcript (reads only the tail). */
function lastAssistantText(path: string | undefined): string {
  if (!path || !existsSync(path)) return ''
  try {
    const size = statSync(path).size
    const len = Math.min(size, 64 * 1024)
    const buf = Buffer.alloc(len)
    const fd = openSync(path, 'r')
    readSync(fd, buf, 0, len, size - len)
    closeSync(fd)
    const lines = buf.toString('utf8').split('\n').reverse()
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue
      try {
        const d = JSON.parse(line)
        const content = d.message?.content
        if (d.type === 'assistant' && Array.isArray(content)) {
          const text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
          if (text.trim()) return clip(text)
        }
      } catch {}
    }
  } catch {}
  return ''
}

function maybeRename(sid: string, prompt: unknown) {
  const s = getSession(sid)
  const p = clip(prompt, 48)
  if (s && p && DEFAULT_NAME.test(s.name) && !p.startsWith('/')) patchSession(sid, { name: p })
}

/** Applies a hook to session status; returns the hook's stdout reply (extra model context) when there is one. */
export function handleHook(provider: string, sid: string, event: string, payload: any) {
  if (!getSession(sid)) return {}
  applyHook(provider, sid, event, payload)
  const additionalContext = userEditContext(sid, event, payload)
  return additionalContext ? { hookSpecificOutput: { hookEventName: event, additionalContext } } : {}
}

function applyHook(provider: string, sid: string, event: string, payload: any) {
  const s = getSession(sid)!
  recordEvent(sid, `${provider}:${event}`, payload)

  if (provider === 'claude') {
    if (payload?.session_id && payload.session_id !== s.agentSessionId) patchSession(sid, { agentSessionId: payload.session_id }, false)
    switch (event) {
      case 'SessionStart':
        if (s.status === 'starting') setStatus(sid, 'idle')
        break
      case 'UserPromptSubmit':
        maybeRename(sid, payload?.prompt)
        setStatus(sid, 'running', clip(payload?.prompt, 80))
        break
      case 'PreToolUse':
      case 'PostToolUse':
        setStatus(sid, 'running', payload?.tool_name ? `Using ${payload.tool_name}` : '')
        break
      case 'Notification': {
        const msg = clip(payload?.message) || 'Needs your input'
        const idle = /waiting for your input/i.test(msg)
        if (idle && (s.status === 'done' || s.status === 'idle')) break
        setStatus(sid, 'waiting', msg)
        break
      }
      case 'Stop':
        setStatus(sid, 'done', clip(payload?.last_assistant_message) || lastAssistantText(payload?.transcript_path) || 'Finished')
        break
    }
    return
  }

  if (provider === 'codex') {
    const threadId = payload?.['thread-id'] || payload?.thread_id || payload?.session_id
    if (threadId && threadId !== s.agentSessionId) patchSession(sid, { agentSessionId: threadId }, false)
    switch (event) {
      case 'notify':
        if (payload?.type === 'agent-turn-complete' || payload?.type === 'turn-complete' || !payload?.type)
          setStatus(sid, 'done', clip(payload?.['last-assistant-message'] || payload?.last_assistant_message) || 'Finished')
        else if (/approv|input|request/i.test(String(payload?.type))) setStatus(sid, 'waiting', clip(payload?.message) || 'Needs approval')
        break
      case 'SessionStart':
        if (s.status === 'starting') setStatus(sid, 'idle')
        break
      case 'UserPromptSubmit':
        maybeRename(sid, payload?.prompt)
        setStatus(sid, 'running', clip(payload?.prompt, 80))
        break
      case 'PreToolUse':
      case 'PostToolUse':
        setStatus(sid, 'running', payload?.tool_name ? `Using ${payload.tool_name}` : '')
        break
      case 'PermissionRequest':
      case 'Notification':
        setStatus(sid, 'waiting', clip(payload?.message || payload?.tool_name) || 'Needs approval')
        break
      case 'Stop':
        setStatus(sid, 'done', clip(payload?.last_assistant_message) || 'Finished')
        break
    }
    return
  }
  if (provider === 'qwen') {
    const agentId = payload?.session_id || payload?.sessionId
    if (agentId && agentId !== s.agentSessionId) patchSession(sid, { agentSessionId: agentId }, false)
    switch (event) {
      case 'SessionStart':
        if (s.status === 'starting') setStatus(sid, 'idle')
        break
      case 'UserPromptSubmit': {
        // Qwen re-fires this on every model send; continuations carry no text and must not wipe the detail.
        const text = clip(payload?.submitted_prompt || payload?.prompt)
        if (!text) {
          if (s.status === 'starting' || s.status === 'idle') setStatus(sid, 'running')
          break
        }
        maybeRename(sid, text)
        setStatus(sid, 'running', clip(text, 80))
        break
      }
      case 'PreToolUse':
      case 'PostToolUse':
        setStatus(sid, 'running', payload?.tool_name ? `Using ${payload.tool_name}` : '')
        break
      case 'Notification': {
        const msg = clip(payload?.message)
        const type = String(payload?.notification_type || payload?.type || '')
        // idle_prompt only means the turn ended. Stop already set done, so don't badge it "needs you".
        if (/idle/i.test(type) && (s.status === 'done' || s.status === 'idle')) break
        if (/permission|approval|input|question|idle/i.test(type) || /needs? your|waiting for|approve|permission/i.test(msg))
          setStatus(sid, 'waiting', msg || 'Needs your input')
        break
      }
      case 'Stop':
        setStatus(sid, 'done', clip(payload?.last_assistant_message || payload?.message) || 'Finished')
        break
    }
    return
  }
  log('unknown hook provider', provider, event)
}
