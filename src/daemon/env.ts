import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME, CODEX_HOME } from './paths'
import { log } from './util'

/** Resolve the user's login-shell environment once (like VS Code does), so PATH/nvm/brew match their terminal. */
let cached: Record<string, string> | null = null
export function shellEnv(): Record<string, string> {
  if (cached) return cached
  const shell = process.env.SHELL || '/bin/zsh'
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
  try {
    const marker = '__HELM_ENV__'
    const out = execFileSync(shell, ['-l', '-i', '-c', `echo ${marker}; env -0`], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...base, HELM_RESOLVING_ENV: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const body = out.slice(out.indexOf(marker) + marker.length + 1)
    for (const pair of body.split('\0')) {
      const i = pair.indexOf('=')
      if (i > 0) base[pair.slice(0, i)] = pair.slice(i + 1)
    }
  } catch (e) {
    log('shell env resolution failed, using process env', e)
  }
  for (const k of ['ELECTRON_RUN_AS_NODE', 'HELM_RESOLVING_ENV', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS']) delete base[k]
  base.TERM = 'xterm-256color'
  base.COLORTERM = 'truecolor'
  base.TERM_PROGRAM = 'Helm'
  base.LANG ||= 'en_US.UTF-8'
  cached = base
  return base
}

export function which(bin: string): string | null {
  const env = shellEnv()
  for (const dir of (env.PATH || '').split(':')) {
    const p = join(dir, bin)
    if (dir && existsSync(p)) return p
  }
  return null
}

const KNOWN: Record<string, string[]> = {
  claude: [join(HOME, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
  codex: ['/Applications/ChatGPT.app/Contents/Resources/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
  qwen: ['/opt/homebrew/bin/qwen', '/usr/local/bin/qwen'],
}

export function resolveBinary(name: string): string | null {
  return which(name) || KNOWN[name]?.find((p) => existsSync(p)) || null
}

/** The user's existing Codex `notify` program (we chain to it so Computer Use etc. keep working). */
export function codexUserNotify(): string[] | null {
  try {
    const toml = readFileSync(join(CODEX_HOME, 'config.toml'), 'utf8')
    const m = toml.match(/^notify\s*=\s*(\[[^\]]*\])/m)
    if (!m) return null
    return JSON.parse(m[1]) as string[]
  } catch {
    return null
  }
}
