# Architecture

```
Electron app (UI; may crash or quit freely)
   │  HTTP + WebSocket (127.0.0.1, bearer token)
hubd: background service (Electron binary with ELECTRON_RUN_AS_NODE)
   ├─ Terminal host (helm-core-ptyhost): node-pty plus a headless xterm mirror per session, for exact screen restore
   ├─ SQLite (better-sqlite3, WAL): ~/Library/Application Support/Helm Core/helm.db
   ├─ Hook receiver: Claude Code hooks (via --settings), Codex notify (chained to any existing notify program)
   ├─ MCP bridge: a stdio shim each agent loads, forwarding to REST on the service (tasks, evidence, reviews)
   ├─ Transcript indexer: ~/.claude/projects, ~/.codex/sessions, ~/.qwen → FTS5 search and token usage
   ├─ Headless runner: `claude -p` / `codex exec` with the role's model (subscription auth, no API keys)
   └─ Scheduler: cron-style recurring agent runs
```

**Why a background service:** agents keep running when the window closes or crashes, and other clients (a phone app, a
team server) can use the same API later.

**Why a separate terminal host:** the service can restart or update without ending terminals. The host speaks a small
newline-delimited JSON protocol over a private unix socket (`src/daemon/ptyhost/protocol.ts`). That protocol must stay
backward compatible, because an older host keeps serving newer services.

**Why wrap CLIs instead of SDKs:** you keep your subscription logins, the full terminal UI and every new CLI feature.
Any CLI can become a provider: a command, model and effort flags, a resume command and a status adapter
(`src/daemon/providers/`).

## Session status

| Status | Source |
|---|---|
| `running` | UserPromptSubmit / PreToolUse hooks, terminal output |
| `waiting` | Claude `Notification` hook (permission or idle prompt), Codex approval notifications, terminal bell |
| `done` | Claude `Stop` hook, Codex turn complete with no pending question |
| `exited` / `error` | Process exit code |

"Needs you" = waiting sessions, finished sessions you haven't seen, tasks waiting for your review, and pinned projects
that have gone quiet.

## Model roles

Roles: `plan`, `implement`, `bugfix`, `review`, `grunt`, `data`. Each maps to `{provider, model, effort}`. Models are
discovered from each CLI and can be edited in Settings. A task's review can be forced to a different provider than the
one that implemented it.

## Plans and progress

- Project: a one-line goal, a short brief, and an optional plan file in the repo (`docs/plan/PLAN.md` or `ROADMAP.md`).
- Milestones contain major tasks. Tasks are meant to be substantial pieces of work, not individual steps.
- Task lifecycle: `backlog → todo → in_progress → ai_review → human_review → done`, plus `blocked` and `wont_do`.
  Tasks can also be archived (hidden, history kept).
- AI review requires evidence attached through MCP. Your approval comes after it, from the Reviews view.
- The database holds live state. Helm can write a `docs/plan/PROGRESS.md` snapshot to the repo on demand.

## Recovery

While terminals run, Helm saves their screens every few seconds and on shutdown. After a restart, the **Workspace
restored** banner offers to resume every interrupted session. Claude and Codex resume the exact saved conversation;
every agent also gets a recovery brief with its original instructions, latest handoff (`helm_checkpoint`), task
progress and the last terminal output.

## Data and security

- Everything is local. The service listens on 127.0.0.1 only and requires a bearer token.
- Each agent session gets its own scoped token: it can use its MCP tools but can't change settings or approve its own
  work.
