import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProviderId, RoleId } from '@shared/types'
import { resolveBinary, shellEnv } from '../env'
import { getRole } from '../services/models'
import { log, now } from '../util'
import { HOME } from '../paths'

export interface HeadlessOpts {
  role: RoleId
  prompt: string
  cwd?: string
  /** 'none' = pure text generation; 'read' = can read the repo; 'all' = full agent (+ Chrome for Claude). */
  tools?: 'none' | 'read' | 'all'
  schema?: object
  timeoutMs?: number
  override?: { provider?: ProviderId; model?: string; effort?: string | null }
  /** Extra args for the provider CLI (e.g. MCP config). */
  extraArgs?: string[]
}

export interface HeadlessResult {
  text: string
  json: any
  provider: ProviderId
  model: string
  ms: number
}

const running = new Set<number>()
export const headlessActive = () => running.size

function exec(file: string, args: string[], cwd: string, timeoutMs: number, stdin?: string, extraEnv?: Record<string, string>): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const env = { ...shellEnv(), ...extraEnv }
    for (const key of ['HELM_SESSION_ID', 'HELM_TOKEN', 'HELM_URL']) delete env[key]
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    if (child.pid) running.add(child.pid)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Headless run timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (child.pid) running.delete(child.pid)
      resolve({ out, err, code })
    })
    if (stdin) child.stdin.write(stdin)
    child.stdin.end()
  })
}

function extractJson(text: string): any {
  const t = text.trim()
  try {
    return JSON.parse(t)
  } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence)
    try {
      return JSON.parse(fence[1])
    } catch {}
  const first = t.search(/[[{]/)
  const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (first >= 0 && last > first)
    try {
      return JSON.parse(t.slice(first, last + 1))
    } catch {}
  return null
}

// A user's global CLAUDE.md/AGENTS.md may tell interactive sessions to save copy to ~/Downloads files. A headless call's
// reply IS the output, so without this the model "writes a file" as fake tool-call text instead of returning the draft.
const TEXT_ONLY =
  'You are running headless inside Helm. Your reply text is the entire output and is used verbatim. Do not write, save or ' +
  'mention files, do not print file paths, and do not emit tool-call markup. Ignore any instruction to put copy in a file.'

/** Run a one-shot, non-interactive model call through the user's subscription CLIs. */
export async function runHeadless(o: HeadlessOpts): Promise<HeadlessResult> {
  const textOnly = o.tools === 'none' || !o.tools
  const cfg = getRole(o.role)
  const provider = o.override?.provider || cfg.provider
  const model = o.override?.model || (provider === cfg.provider ? cfg.model : '')
  const effort = o.override?.effort !== undefined ? o.override.effort : provider === cfg.provider ? cfg.effort : null
  const cwd = o.cwd || HOME
  const timeout = o.timeoutMs || 5 * 60_000
  const t0 = now()

  if (provider === 'claude') {
    const bin = resolveBinary('claude')
    if (!bin) throw new Error('Claude CLI not found')
    const args = ['-p', '--output-format', 'json', '--no-session-persistence']
    if (model) args.push('--model', model)
    if (effort) args.push('--effort', effort)
    if (textOnly) args.push('--tools', '', '--append-system-prompt', TEXT_ONLY)
    else if (o.tools === 'read') args.push('--tools', 'Read,Glob,Grep,LS', '--permission-mode', 'dontAsk')
    else args.push('--permission-mode', 'auto')
    if (o.schema) args.push('--json-schema', JSON.stringify(o.schema))
    if (o.extraArgs) args.push(...o.extraArgs)
    const { out, err, code } = await exec(bin, args, cwd, timeout, o.prompt)
    let text = out
    try {
      const d = JSON.parse(out)
      if (d.is_error) throw new Error(d.result || 'Claude returned an error')
      text = d.structured_output ? JSON.stringify(d.structured_output) : d.result ?? out
    } catch (e) {
      if (code !== 0) throw new Error(`claude exited ${code}: ${(err || out).slice(0, 400)}`)
      if (e instanceof Error && e.message !== 'Unexpected end of JSON input' && !(e instanceof SyntaxError)) throw e
    }
    log(`headless claude/${model} ${o.role} ${now() - t0}ms`)
    return { text, json: extractJson(text), provider, model, ms: now() - t0 }
  }

  if (provider === 'codex') {
    const bin = resolveBinary('codex')
    if (!bin) throw new Error('Codex CLI not found')
    const dir = mkdtempSync(join(tmpdir(), 'helm-codex-'))
    const outFile = join(dir, 'last.txt')
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-o', outFile, '-C', cwd]
    if (model) args.push('-m', model)
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`)
    args.push('-s', o.tools === 'all' ? 'workspace-write' : 'read-only')
    if (o.schema) {
      const sf = join(dir, 'schema.json')
      writeFileSync(sf, JSON.stringify(o.schema))
      args.push('--output-schema', sf)
    }
    if (o.extraArgs) args.push(...o.extraArgs)
    args.push('-') // prompt from stdin
    try {
      const { err, code } = await exec(bin, args, cwd, timeout, textOnly ? `${TEXT_ONLY}\n\n${o.prompt}` : o.prompt)
      let text = ''
      try {
        text = readFileSync(outFile, 'utf8')
      } catch {}
      if (code !== 0) throw new Error(`codex exited ${code}: ${err.slice(-400)}`)
      log(`headless codex/${model} ${o.role} ${now() - t0}ms`)
      return { text, json: extractJson(text), provider, model, ms: now() - t0 }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  if (provider === 'qwen') {
    const bin = resolveBinary('qwen')
    if (!bin) throw new Error('Qwen Code CLI not found')
    // Deliberately no --bare: it skips the startup auto-discovery that carries Qwen's Coding Plan
    // provider/auth, so "disable discovery but preserve authentication" is not achievable with it.
    // System settings deep-merge over user settings rather than replacing them (verified on 0.24.6).
    // Won't fix for now; scope a headless run with --allowed-mcp-server-names or
    // --disabled-slash-commands instead if that is ever wanted.
    const args = ['--output-format', 'json', '--approval-mode', o.tools === 'all' ? 'yolo' : 'plan', '--max-wall-time', `${Math.max(1, Math.ceil(timeout / 1000))}s`]
    if (model) args.push('--model', model)
    if (o.schema) args.push('--json-schema', JSON.stringify(o.schema))
    if (o.extraArgs) args.push(...o.extraArgs)
    // Effort has no CLI flag, so it rides in a per-run settings file. System settings deep-merge
    // over user settings, so the Coding Plan auth in ~/.qwen/settings.json still applies. Always
    // injected, even when empty: a daemon launched from inside a Helm Qwen terminal inherits that
    // terminal's QWEN_CODE_SYSTEM_SETTINGS_PATH, which must not leak into a headless run.
    const dir = mkdtempSync(join(tmpdir(), 'helm-qwen-'))
    const settingsFile = join(dir, 'settings.json')
    try {
      writeFileSync(settingsFile, JSON.stringify(effort ? { model: { reasoningEffort: effort } } : {}))
      // Prompt over stdin, not argv: -p is deprecated and argv exposes it to `ps`.
      const { out, err, code } = await exec(bin, args, cwd, timeout, textOnly ? `${TEXT_ONLY}\n\n${o.prompt}` : o.prompt, { QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsFile })
      if (code !== 0) throw new Error(`qwen exited ${code}: ${(err || out).slice(-400)}`)
      let text = out
      try {
        const d = JSON.parse(out)
        const result = Array.isArray(d) ? [...d].reverse().find((x) => x?.type === 'result') : d
        text = result?.structured_output ? JSON.stringify(result.structured_output) : result?.result ?? result?.response ?? result?.message?.content ?? out
      } catch {}
      log(`headless qwen/${model} ${o.role} ${now() - t0}ms`)
      return { text, json: extractJson(text), provider, model, ms: now() - t0 }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  throw new Error(`Provider ${provider} can't run headless`)
}
