import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, realpathSync } from 'node:fs'

export function canonicalPath(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

export const HOME = homedir()
export const DATA_DIR = process.env.HELM_DATA_DIR || join(HOME, 'Library', 'Application Support', 'Helm Core')
export const DB_PATH = join(DATA_DIR, 'helm.db')
export const DAEMON_FILE = join(DATA_DIR, 'daemon.json')
export const LOG_FILE = join(DATA_DIR, 'hubd.log')
export const RUNTIME_DIR = join(DATA_DIR, 'runtime')
export const EVIDENCE_DIR = join(DATA_DIR, 'evidence')
export const WORKTREE_DIR = join(DATA_DIR, 'worktrees')
export const CLAUDE_PROJECTS = join(HOME, '.claude', 'projects')
export const CODEX_HOME = process.env.CODEX_HOME || join(HOME, '.codex')
export const QWEN_HOME = process.env.QWEN_HOME || join(HOME, '.qwen')

for (const d of [DATA_DIR, RUNTIME_DIR, EVIDENCE_DIR]) mkdirSync(d, { recursive: true })
