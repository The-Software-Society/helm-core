import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { DAEMON_FILE, RUNTIME_DIR } from './paths'
import { codexUserNotify } from './env'
import { getSetting, setSetting } from './db'
import { usingHost } from './ptyhost/client'

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Process-wide runtime facts: where the daemon listens and the helper scripts agents call back into. */
export const runtime = {
  port: 0,
  token: '',
  get url() {
    return `http://127.0.0.1:${this.port}`
  },
  shimPath: '',
  hookScript: join(RUNTIME_DIR, 'hook.sh'),
  codexNotifyScript: join(RUNTIME_DIR, 'codex-notify.sh'),
  /** Per-launch Codex args that wire status signals back to Helm. */
  codexHookOverrides: (): string[] => {
    // Safe default: Codex's own TUI notifications (OSC 9 in the PTY stream) signal approvals; notify signals turn end.
    const args = ['-c', 'tui.notifications=true', '-c', 'tui.notification_method="osc9"', '-c', 'tui.notification_condition="always"']
    // Opt-in: full lifecycle hooks. Requires bypassing Codex hook trust, which also trusts repo-level hooks.
    if (getSetting<boolean>('codex.fullHooks', false)) {
      const h = (ev: string) => `[{hooks=[{type="command",command=${JSON.stringify(`/bin/sh ${shq(join(RUNTIME_DIR, 'hook.sh'))} codex ${ev}`)},timeout=5}]}]`
      args.push('--dangerously-bypass-hook-trust')
      for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop']) args.push('-c', `hooks.${ev}=${h(ev)}`)
    }
    return args
  },
}

/** Stable token across daemon restarts so long-lived agent processes (and the terminal host) keep working. */
export function daemonToken() {
  let token = getSetting<string>('daemon.token', '')
  if (!token) {
    token = randomBytes(24).toString('hex')
    setSetting('daemon.token', token)
  }
  return token
}

export function initRuntime(port: number) {
  runtime.port = port
  runtime.token = daemonToken()
  runtime.shimPath = join(dirname(process.argv[1] || __filename), 'mcp-shim.js')
  if (!existsSync(runtime.shimPath)) runtime.shimPath = join(__dirname, 'mcp-shim.js')

  writeFileSync(
    runtime.hookScript,
    `#!/bin/sh
# Helm hook relay: $1 = provider, $2 = event. Payload (JSON) arrives on stdin.
[ -z "$HELM_URL" ] && { cat >/dev/null; exit 0; }
out=$(curl -s -m 3 -X POST -H "Authorization: Bearer $HELM_TOKEN" -H "Content-Type: application/json" \\
  --data-binary @- "$HELM_URL/hooks/$1/$HELM_SESSION_ID?event=$2" 2>/dev/null)
# Replies carry extra model context (e.g. the user's hand edits); an empty {} means nothing to add.
case "$out" in '{"hookSpecificOutput"'*) printf '%s' "$out" ;; esac
exit 0
`,
  )
  chmodSync(runtime.hookScript, 0o755)

  const orig = codexUserNotify()
  writeFileSync(
    runtime.codexNotifyScript,
    `#!/bin/sh
# Helm Codex notify relay. Codex appends the JSON payload as the final argument.
for last; do :; done
if [ -n "$HELM_URL" ]; then
  printf '%s' "$last" | curl -s -m 3 -X POST -H "Authorization: Bearer $HELM_TOKEN" -H "Content-Type: application/json" \\
    --data-binary @- "$HELM_URL/hooks/codex/$HELM_SESSION_ID?event=notify" >/dev/null 2>&1
fi
${orig?.length ? `# chain to the user's configured notify program\nexec ${orig.map(shq).join(' ')} "$@"` : 'exit 0'}
`,
  )
  chmodSync(runtime.codexNotifyScript, 0o755)

  const build = createHash('sha1').update(readFileSync(process.argv[1] || __filename)).digest('hex').slice(0, 12)
  writeFileSync(DAEMON_FILE, JSON.stringify({ port, token: runtime.token, terminalHost: usingHost(), pid: process.pid, build, runtimePath: process.argv[1], executable: process.execPath, startedAt: Date.now() }, null, 2), { mode: 0o600 })
}
