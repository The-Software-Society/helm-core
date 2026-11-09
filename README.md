# Helm Core

A macOS desktop app for running and steering many Claude Code, Codex and Qwen Code agent sessions across all your
projects, from one window.

If you run several AI coding agents at once, you end up with a pile of terminals, no idea which one is waiting on you,
and lost work when something restarts. Helm Core fixes that. It keeps every agent in a terminal that survives app
crashes and restarts, and it shows which sessions need you. It also plans work as milestones and tasks that the agents
update themselves. A task only counts as done after it passes an independent AI review and you approve it.

**Who it's for:** developers and small teams who work with CLI coding agents every day across more than one repository.

**Status:** used daily on macOS (Apple silicon). Early and changing fast. See [ROADMAP.md](ROADMAP.md).

## What it does

- **Terminals that survive.** Agents run in a separate terminal host. Closing or crashing the window, or restarting the
  background service, leaves them running. After a reboot, each session resumes its saved conversation with a recovery
  brief.
- **"Needs you" at a glance.** Each session reports `running`, `waiting` or `done` (from Claude Code hooks, Codex
  notifications and terminal signals). The sidebar shows which agents are waiting for a decision.
- **Plans agents can work with.** Each project has milestones and tasks. Agents read and update them through a built-in
  MCP server (`helm_task_progress`, `helm_attach_evidence`, `helm_submit_for_review` and others).
- **Two-stage review.** A task needs attached evidence (tests, screenshots, diffs). It then goes through an independent
  AI review, by default from a *different* provider than the one that built it, and finally your approval.
- **Model routing by role.** Plan, implement, bug hunt, review, grunt work and writing each map to the provider, model
  and effort level you choose.
- **Searchable history.** Indexes your Claude Code, Codex and Qwen transcripts (SQLite FTS5), so you can search and
  resume any past conversation, including ones started outside Helm.
- **Insights.** Tasks completed per week, token usage by model, and projects that have gone quiet.
- **Schedules.** Recurring agent runs on a cron schedule, such as a nightly security scan or a morning brief.
- **Pilot.** An optional orchestrator session that can see and direct the other sessions.

Helm wraps the real CLIs instead of calling model APIs. Your logins, settings, skills and CLAUDE.md/AGENTS.md files all
keep working, and **it never needs an API key**.

## Built with

Electron, React 19, TypeScript, Tailwind CSS 4, TanStack Query, Zustand, xterm.js, node-pty, SQLite (better-sqlite3 with
FTS5), the Model Context Protocol SDK, croner and electron-vite.

## Requirements

- macOS on Apple silicon
- Node.js 22.12 or newer (`.nvmrc` pins 24) and pnpm
- At least one agent CLI installed and logged in: [Claude Code](https://docs.claude.com/en/docs/claude-code),
  [Codex CLI](https://github.com/openai/codex) or [Qwen Code](https://github.com/QwenLM/qwen-code)

## Run it

```sh
nvm use
pnpm install          # also rebuilds node-pty and better-sqlite3 for Electron
pnpm test             # regression suite in a scratch data folder (no model calls)
pnpm dev              # "Helm Core Dev" with hot reload and its own data folder
```

On first launch, Home suggests folders you've worked in recently (from `~/.claude/projects` and `~/.codex/sessions`).
Add a few, open one, and press ⌘T to start an agent.

To build and install the app locally:

```sh
pnpm update:prepare   # typecheck, tests, recovery and updater checks, then package
pnpm install:mac      # installs ~/Applications/Helm Core.app and opens it at login
```

## How it works

```
Helm Core.app (Electron UI; can close or crash freely)
   │  HTTP + WebSocket on 127.0.0.1, bearer token
hubd (background service)
   ├─ helm-core-ptyhost: owns every terminal and outlives hubd restarts
   ├─ SQLite: ~/Library/Application Support/Helm Core/helm.db
   ├─ Status: Claude Code hooks, Codex notify + OSC 9, prompt detection
   ├─ MCP server: agents report progress, attach evidence, submit for review
   ├─ Transcript indexer (Claude, Codex, Qwen JSONL → FTS5) and token usage
   ├─ Headless runner: `claude -p` / `codex exec` with the role's model
   └─ Scheduler
```

More detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Keyboard

⌘K palette · ⌘O open project · ⌘T new session · ⌘⇧T shell · ⌘D split · ⌘W close pane · ⌘1–9 jump to session ·
⌘J next thing that needs you · ⌘B sidebar · ⇧↵ newline in agent prompts

## Privacy

Everything stays on your machine. The database, transcript index and evidence files live under
`~/Library/Application Support/Helm Core`. Helm Core doesn't send data anywhere itself. The agent CLIs you run talk to
their own providers as usual.

## Contributing

Issues and pull requests are welcome. Run `pnpm typecheck` and `pnpm test` before opening a PR. [CLAUDE.md](CLAUDE.md)
covers the conventions and doubles as the guide for AI agents working on this repo.

## License

[MIT](LICENSE) © 2026 The Software Society
