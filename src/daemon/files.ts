import { resolve } from 'node:path'
import { EVIDENCE_DIR } from './paths'

/** Only evidence files Helm copied into its own store are served over HTTP. */
export function isServableFile(p: string) {
  const abs = resolve(p)
  return abs.startsWith(EVIDENCE_DIR + '/')
}
