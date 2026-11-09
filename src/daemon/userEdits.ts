import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { db } from './db'
import { HttpError } from './server'
import { DAY, id, json, now } from './util'

// Edits the user saves by hand in the file viewer. They're not prompts: the session that showed the file gets the diff as
// hook context on its next prompt or tool call, and any agent that later writes the file is told if it dropped them.

const DIFF_LIMIT = 6000
const GUARD_DAYS = 60

interface SaveInput { path: string; text: string; base?: string; sessionId?: string }

export function saveUserEdit({ path, text, base, sessionId }: SaveInput) {
  if (!path || !isAbsolute(path)) throw new HttpError(400, 'path must be absolute')
  if (typeof text !== 'string') throw new HttpError(400, 'text required')
  if (existsSync(path) && !statSync(path).isFile()) throw new HttpError(400, 'not a file')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (base !== undefined && current !== base) throw new HttpError(409, 'The file changed on disk since you opened it')
  if (current === text) return { saved: false }
  writeFileSync(path, text)
  // Lines the user wrote earlier and has now removed stop being guarded.
  const keep = db.prepare('UPDATE user_edits SET added = ? WHERE id = ?')
  for (const r of db.prepare('SELECT id, added FROM user_edits WHERE path = ?').all(path) as any[])
    keep.run(JSON.stringify(json<string[]>(r.added, []).filter((l) => text.includes(l))), r.id)
  const { diff, added } = lineDiff(current, text)
  db.prepare('INSERT INTO user_edits(id, path, session_id, diff, added, created_at) VALUES(?, ?, ?, ?, ?, ?)').run(
    id('ue'), path, sessionId || null, diff, JSON.stringify(added), now(),
  )
  return { saved: true }
}

/** Minimal line diff: common prefix/suffix trimmed, LCS on the rest. Returns -/+ hunks and the lines the user wrote. */
function lineDiff(before: string, after: string) {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--
  const x = a.slice(start, endA), y = b.slice(start, endB)
  const ops: string[] = []
  if (x.length * y.length > 4_000_000) {
    for (const l of x) ops.push(`- ${l}`)
    for (const l of y) ops.push(`+ ${l}`)
  } else {
    const m = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1))
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--) m[i][j] = x[i] === y[j] ? m[i + 1][j + 1] + 1 : Math.max(m[i + 1][j], m[i][j + 1])
    let i = 0, j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) ops.push(`  ${x[i++]}`), j++
      else if (i < x.length && (j >= y.length || m[i + 1][j] >= m[i][j + 1])) ops.push(`- ${x[i++]}`)
      else ops.push(`+ ${y[j++]}`)
    }
  }
  const context = [...a.slice(Math.max(0, start - 2), start).map((l) => `  ${l}`)]
  const tail = a.slice(endA, endA + 2).map((l) => `  ${l}`)
  let diff = `@@ line ${start + 1} @@\n${[...context, ...ops, ...tail].join('\n')}`
  if (diff.length > DIFF_LIMIT) diff = `${diff.slice(0, DIFF_LIMIT)}\n… (diff truncated; read the file for the rest)`
  const added = ops.filter((l) => l.startsWith('+ ')).map((l) => l.slice(2).trim()).filter((l) => l.length >= 3)
  return { diff, added }
}

const time = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/** Hook context for a session: pending hand edits, plus a warning if a write just dropped lines the user wrote. */
export function userEditContext(sid: string, event: string, payload: any): string {
  if (event !== 'UserPromptSubmit' && event !== 'PostToolUse') return ''
  const parts: string[] = []
  const pending = db.prepare('SELECT id, path, diff, created_at FROM user_edits WHERE session_id = ? AND delivered_at IS NULL ORDER BY created_at').all(sid) as any[]
  if (pending.length) {
    parts.push([
      'The user edited these files directly in Helm\'s file viewer. This is context, not a new request: don\'t reply to it or act on it by itself.',
      'Every change below is intentional. It is now the direction for that file: keep it in all later revisions and rounds, apply the same choices to related work, and re-read the file before you edit it. Only undo one of these changes if the user explicitly asks.',
      ...pending.map((e) => `${e.path} (saved ${time(e.created_at)}):\n\`\`\`diff\n${e.diff}\n\`\`\``),
    ].join('\n\n'))
    const mark = db.prepare('UPDATE user_edits SET delivered_at = ? WHERE id = ?')
    for (const e of pending) mark.run(now(), e.id)
  }
  const path = event === 'PostToolUse' ? payload?.tool_input?.file_path || payload?.tool_input?.path : ''
  if (typeof path === 'string' && path && existsSync(path)) {
    const rows = db.prepare('SELECT id, added FROM user_edits WHERE path = ? AND created_at > ? ORDER BY created_at').all(path, now() - GUARD_DAYS * DAY) as any[]
    if (rows.length) {
      const text = readFileSync(path, 'utf8')
      const missing = [...new Set(rows.flatMap((r) => json<string[]>(r.added, [])))].filter((l) => !text.includes(l))
      // Warn once per line: if the user did ask for the change, later writes shouldn't keep nagging.
      const keep = db.prepare('UPDATE user_edits SET added = ? WHERE id = ?')
      for (const r of rows) keep.run(JSON.stringify(json<string[]>(r.added, []).filter((l) => !missing.includes(l))), r.id)
      if (missing.length)
        parts.push(`Your write to ${path} removed or changed lines the user wrote by hand. Restore them unless the user asked for this exact change:\n${missing.slice(0, 20).map((l) => `- ${l}`).join('\n')}`)
    }
  }
  return parts.join('\n\n')
}
