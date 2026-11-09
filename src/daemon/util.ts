import { customAlphabet } from 'nanoid'
import { appendFileSync } from 'node:fs'
import { LOG_FILE } from './paths'

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)
export const id = (prefix: string) => `${prefix}_${nano()}`
export const now = () => Date.now()

export function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`
  try {
    appendFileSync(LOG_FILE, line)
  } catch {}
  if (process.env.HELM_DEBUG) process.stderr.write(line)
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: NodeJS.Timeout | null = null
  return (...a: A) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}

export const DAY = 86_400_000

/** The calendar day (YYYY-MM-DD) of an instant, in the Mac's current time zone. */
export const localDay = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

