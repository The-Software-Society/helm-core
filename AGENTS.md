# Working on Helm Core

Read `CLAUDE.md` (conventions and safety rules), `README.md` and `docs/ARCHITECTURE.md`. The same rules apply to every
agent: keep `pnpm typecheck` and `pnpm test` passing, test against a scratch `HELM_DATA_DIR`, use only made-up data, and
never restart or kill a real Helm service or terminal host.
