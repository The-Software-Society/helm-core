// Wire protocol between hubd and helm-ptyhost: newline-delimited JSON over a private unix socket.
// The host outlives hubd, so this protocol must stay backward compatible — add fields, never repurpose them.
import { createHash, createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PTYHOST_PROTOCOL = 1

/** Unix socket paths max out at 104 bytes on macOS — keep it short and keyed to the data dir. */
export const hostSocketPath = (dataDir: string) => join(tmpdir(), `helm-pty-${createHash('sha1').update(dataDir).digest('hex').slice(0, 12)}.sock`)

/** The host only talks to a hubd that holds the workspace token. */
export const hostToken = (daemonToken: string) => createHmac('sha256', daemonToken).update('helm-ptyhost').digest('hex')

export interface HostTerm {
  id: string
  pid: number
  cols: number
  rows: number
  /** Exit code once the process ended (kept until hubd reaps it). */
  exit: number | null
}

export type ToHost =
  | { t: 'hello'; token: string; protocol: number }
  | { t: 'spawn'; id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
  | { t: 'attach'; id: string; rid: number }
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; id: string; signal?: string }
  | { t: 'reap'; id: string }

export type FromHost =
  | { t: 'hello'; pid: number; protocol: number; terms: HostTerm[] }
  | { t: 'spawned'; id: string; pid: number }
  | { t: 'spawn-failed'; id: string; error: string }
  | { t: 'snapshot'; rid: number; id: string; data: string; exit: number | null }
  | { t: 'data'; id: string; data: string }
  | { t: 'exit'; id: string; code: number }
  | { t: 'error'; message: string }

/** Split a socket stream into JSON lines. */
export function lineReader(onMessage: (m: any) => void) {
  let buf = ''
  return (chunk: Buffer | string) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line))
      } catch {}
    }
  }
}
