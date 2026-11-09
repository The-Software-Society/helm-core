import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderId, Session } from '@shared/types'
import { resolveBinary, shellEnv } from '../env'
import { RUNTIME_DIR } from '../paths'
import { runtime } from '../runtime'
import { sessionToken } from '../auth'

export interface LaunchSpec {
  file: string
  args: string[]
  env: Record<string, string>
  agentSessionId: string | null
}

export interface LaunchOpts {
  session: Session
  prompt?: string
  resume?: boolean
  systemContext?: string
}

export interface ProviderInfo {
  id: ProviderId
  label: string
  binary: string | null
  available: boolean
  resumable: boolean
}

function helmEnv(sessionId: string): Record<string, string> {
  return { HELM_URL: runtime.url, HELM_TOKEN: sessionToken(sessionId), HELM_SESSION_ID: sessionId }
}

function mcpServer(sessionId: string) {
  return {
    command: process.execPath,
    args: [runtime.shimPath],
    env: { ELECTRON_RUN_AS_NODE: '1', ...helmEnv(sessionId) },
  }
}

// ---------------- Claude Code ----------------
function claudeLaunch({ session, prompt, resume, systemContext }: LaunchOpts): LaunchSpec {
  const bin = resolveBinary('claude')
  if (!bin) throw new Error('Claude Code CLI not found (expected `claude` on PATH)')
  const hook = (event: string) => [{ hooks: [{ type: 'command', command: `/bin/sh '${runtime.hookScript}' claude ${event}`, timeout: 5 }] }]
  const settings = {
    // Helm's own MCP tools (task progress, evidence, review) never need a permission prompt.
    permissions: { allow: ['mcp__helm'] },
    hooks: {
      SessionStart: hook('SessionStart'),
      UserPromptSubmit: hook('UserPromptSubmit'),
      PreToolUse: [{ matcher: '*', hooks: hook('PreToolUse')[0].hooks }],
      PostToolUse: [{ matcher: '*', hooks: hook('PostToolUse')[0].hooks }],
      Notification: hook('Notification'),
      Stop: hook('Stop'),
      SessionEnd: hook('SessionEnd'),
    },
  }
  const settingsFile = join(RUNTIME_DIR, `claude-settings-${session.id}.json`)
  writeFileSync(settingsFile, JSON.stringify(settings))
  const mcpFile = join(RUNTIME_DIR, `claude-mcp-${session.id}.json`)
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { helm: { type: 'stdio', ...mcpServer(session.id) } } }))

  const agentSessionId = resume && session.agentSessionId ? session.agentSessionId : randomUUID()
  const args: string[] = []
  if (resume && session.agentSessionId) args.push('--resume', session.agentSessionId)
  else args.push('--session-id', agentSessionId)
  if (session.model) args.push('--model', session.model)
  if (session.effort) args.push('--effort', session.effort)
  args.push('--settings', settingsFile, '--mcp-config', mcpFile)
  if (systemContext) args.push('--append-system-prompt', systemContext)
  if (prompt) args.push('--', prompt)
  return { file: bin, args, env: { ...shellEnv(), ...helmEnv(session.id) }, agentSessionId }
}

// ---------------- Codex ----------------
const toml = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(toml).join(',')}]` : typeof v === 'object' && v ? `{${Object.entries(v).map(([k, x]) => `${k}=${toml(x)}`).join(',')}}` : JSON.stringify(v)

function codexLaunch({ session, prompt, resume, systemContext }: LaunchOpts): LaunchSpec {
  const bin = resolveBinary('codex')
  if (!bin) throw new Error('Codex CLI not found')
  const args: string[] = []
  if (session.model) args.push('-m', session.model)
  if (session.effort) args.push('-c', `model_reasoning_effort=${toml(session.effort)}`)
  // Inline TUI preserves terminal scrollback while retaining Codex's formatted chat.
  // Raw output exposes tool protocol and bypasses the normal chat presentation.
  args.push('--no-alt-screen', '-c', 'tui.raw_output_mode=false')
  args.push('-c', `notify=${toml(['/bin/sh', runtime.codexNotifyScript])}`)
  args.push(...runtime.codexHookOverrides())
  args.push('-c', `mcp_servers.helm=${toml(mcpServer(session.id))}`)
  // Codex has no append-system-prompt flag; task context leads the opening prompt instead.
  const opening = [systemContext, prompt].filter(Boolean).join('\n\n')
  if (resume && session.agentSessionId) {
    args.push('resume', session.agentSessionId)
    if (opening) args.push('--', opening)
  } else if (opening) args.push('--', opening)
  return { file: bin, args, env: { ...shellEnv(), ...helmEnv(session.id) }, agentSessionId: resume ? session.agentSessionId : null }
}

// ---------------- Qwen (generic CLI) ----------------
function qwenLaunch({ session, prompt, resume, systemContext }: LaunchOpts): LaunchSpec {
  const bin = resolveBinary('qwen')
  if (!bin) throw new Error('Qwen Code CLI not found (npm i -g @qwen-code/qwen-code)')
  const hook = (event: string, matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `/bin/sh '${runtime.hookScript}' qwen ${event}`, timeout: 5 }] }]
  const settingsFile = join(RUNTIME_DIR, `qwen-settings-${session.id}.json`)
  writeFileSync(settingsFile, JSON.stringify({
    // Without this every helm_* call stops the terminal on a confirmation prompt.
    permissions: { allow: ['mcp__helm'] },
    // Qwen has no --effort flag; reasoning effort is a setting. -m still selects the model.
    ...(session.effort ? { model: { reasoningEffort: session.effort } } : {}),
    hooks: {
      SessionStart: hook('SessionStart'),
      UserPromptSubmit: hook('UserPromptSubmit'),
      PreToolUse: hook('PreToolUse', '*'),
      PostToolUse: hook('PostToolUse', '*'),
      Notification: hook('Notification'),
      Stop: hook('Stop'),
      SessionEnd: hook('SessionEnd'),
    },
  }))
  const mcpFile = join(RUNTIME_DIR, `qwen-mcp-${session.id}.json`)
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { helm: mcpServer(session.id) } }))
  const agentSessionId = resume && session.agentSessionId ? session.agentSessionId : randomUUID()
  const args: string[] = []
  if (resume && session.agentSessionId) args.push('--resume', session.agentSessionId)
  else args.push('--session-id', agentSessionId)
  // No --allowed-mcp-server-names: --mcp-config merges, so the project's own servers stay available
  // exactly as they are for Claude and Codex.
  args.push('--chat-recording', '--mcp-config', mcpFile)
  if (session.model) args.push('-m', session.model)
  if (systemContext) args.push('--append-system-prompt', systemContext)
  if (prompt) args.push('-i', prompt)
  return { file: bin, args, env: { ...shellEnv(), ...helmEnv(session.id), QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsFile }, agentSessionId }
}

// ---------------- Plain shell ----------------
function shellLaunch({ session }: LaunchOpts): LaunchSpec {
  const shell = shellEnv().SHELL || '/bin/zsh'
  return { file: shell, args: ['-l'], env: { ...shellEnv(), ...helmEnv(session.id) }, agentSessionId: null }
}

export function buildLaunch(opts: LaunchOpts): LaunchSpec {
  switch (opts.session.provider) {
    case 'claude':
      return claudeLaunch(opts)
    case 'codex':
      return codexLaunch(opts)
    case 'qwen':
      return qwenLaunch(opts)
    default:
      return shellLaunch(opts)
  }
}

export function listProviders(): ProviderInfo[] {
  const c = resolveBinary('claude')
  const x = resolveBinary('codex')
  const q = resolveBinary('qwen')
  return [
    { id: 'claude', label: 'Claude Code', binary: c, available: !!c, resumable: true },
    { id: 'codex', label: 'Codex', binary: x, available: !!x, resumable: true },
    { id: 'qwen', label: 'Qwen Code', binary: q, available: !!q, resumable: true },
    { id: 'shell', label: 'Shell', binary: shellEnv().SHELL || '/bin/zsh', available: true, resumable: false },
  ]
}
