import { createHmac, timingSafeEqual } from 'node:crypto'
import { runtime } from './runtime'

export function sessionToken(sessionId: string): string {
  return createHmac('sha256', runtime.token).update(`helm-session:${sessionId}`).digest('hex')
}

export function tokenMatches(actual: string, expected: string): boolean {
  if (!actual || !expected) return false
  const a = Buffer.from(actual), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
