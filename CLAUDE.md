# Helm Core — agent guide

macOS app (Electron + React + SQLite) that hosts Claude Code, Codex and Qwen Code sessions across projects. Read
`README.md` and `docs/ARCHITECTURE.md` first. You may be running *inside* Helm while working on it, so be careful with
the background service (see below).

## Layout
- `src/daemon/` — `hubd`, the long-lived service. Owns the database, hooks, MCP bridge, indexer and scheduler.
  - `routes.ts` core REST; `scheduler/index.ts` and `services/insights.ts` register their own routes.
  - `db/schema.ts` — append-only migrations. Never edit a migration that has shipped in a release; append a new one.
  - `providers/` — how each CLI is launched (flags, hooks, MCP). `pty/manager.ts` — session lifecycle and status.
  - `ptyhost/` — the detached terminal host. Its protocol must stay backward compatible.
  - `llm/runner.ts` — the only way to call a model (headless CLI, role-routed, subscription auth).
- `src/main/` — Electron main: service lifecycle (single instance, build check), window, menu, local updater.
- `src/renderer/src/` — React UI. Data via react-query (`lib/queries.ts`), live patches over WebSocket.
- `src/shared/types.ts` — domain and protocol types shared by both sides.

## Rules
- Match the existing style: terse TS, no semicolons, single quotes, prepared statements, mappers for rows.
- No API keys. Model calls go through `runHeadless` with a role; never hardcode a model in feature code.
- Nothing outbound happens automatically: syncing, pushing or sending anything needs an explicit user action.
- Colors and type come from the tokens in `styles.css`. Validate chart palettes for contrast.
- Use made-up sample data in tests, fixtures and screenshots. Never commit real names, emails or secrets.
- `pnpm typecheck` and `pnpm test` must pass. `pnpm build` before testing the app.

## Testing without touching real data
Always test against a scratch data folder:

```sh
HELM_DATA_DIR=/tmp/helm-scratch HELM_DEBUG_DIR=/tmp/helm-dbg ./node_modules/.bin/electron .
```

- `HELM_DATA_DIR` isolates the database, `daemon.json` and logs. `HELM_PORT` pins the service port (default 47831).
- `HELM_DEBUG_DIR` enables the UI driver: write JS to `$HELM_DEBUG_DIR/cmd.js`; it runs in the renderer, then
  `shot.png` and `result.json` are written. Use it to click through views and check them visually.
- Logs: `$HELM_DATA_DIR/hubd.log` and `ptyhost.log`. Processes are titled `helm-core-hubd` and `helm-core-ptyhost`. For
  a scratch instance, stop both (the host's pid is in `$HELM_DATA_DIR/runtime/ptyhost.json`). Never kill every
  `helm-core-ptyhost` process: that ends every terminal.

## Developing Helm from inside Helm
- `pnpm dev` always launches the isolated "Helm Core Dev" workspace. `HELM_DEV_DATA_DIR` selects a scratch one. CLI
  logins and project files are still shared, so use scratch projects or git worktrees for QA.
- Stop the dev server before building a release: both write `out/`.
- `pnpm update:prepare` runs every release check and produces `release/mac-arm64/Helm Core.app`. Don't bypass failed
  checks or seal a release by hand. Install it with the app's **Install Tested Update** menu or `pnpm install:mac`.
- Restarting the service keeps terminals running (they live in the terminal host). Keep the UI compatible with the
  running service until it's restarted, and don't delete retained release folders that may still own terminals.
