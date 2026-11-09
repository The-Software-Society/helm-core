# Roadmap

Helm Core works today as a single-user macOS app. The next stretch turns it into a real project-management tool for
agent-driven work, then opens it up to small teams.

## 1. Project management (now)

- [ ] Board view per project (columns by status) alongside the current list, with drag to reorder and change status
- [ ] Task dependencies and "blocked by" links; agents see them in `helm_whoami`
- [ ] Due dates and estimates on milestones and tasks; a cross-project "this week" view
- [ ] Task templates and acceptance-criteria checklists that the AI reviewer checks one by one
- [ ] Two-way sync of the plan with a markdown file in the repo (`docs/plan/PLAN.md`), not just export
- [ ] Better evidence: inline image/diff viewer, test-output parsing, links to commits
- [ ] Session ↔ task history: which sessions touched a task, tokens spent, time to done
- [ ] Project and cross-project reports (throughput, review pass rate, cost per task)

## 2. Connectors (next)

- [ ] A connector interface so plans can sync with an outside project tracker (tasks, statuses, comments)
- [ ] First connectors: GitHub Issues/Projects, then Linear
- [ ] Outbox with retries for every outbound sync, so a failed call never loses an update
- [ ] Webhook/poll inbound changes; conflict rules when both sides edit
- [ ] Connector settings UI and per-project mapping

## 3. Teams (later)

- [ ] User accounts and sign-in, starting with a second person on the same machine/network
- [ ] Roles: owner, member, reviewer; reviews can be assigned to a person
- [ ] Shared projects with per-user session lists and "needs you" per person
- [ ] Activity feed and @-mentions on tasks
- [ ] Workspace (tenant) separation in the data model so one service can host several teams
- [ ] Optional self-hosted sync server so a team shares plans while agents still run locally

## 4. Platform and quality

- [ ] Signed and notarized builds; GitHub Releases with auto-update
- [ ] Linux support (the terminal host and indexer are portable; packaging and paths are not yet)
- [ ] More providers (any CLI agent = command + model flag + resume + status adapter)
- [ ] Renderer component tests and an end-to-end smoke test of the packaged app
- [ ] Onboarding: first-run checks for installed CLIs and logins
- [ ] Accessibility pass (keyboard focus, contrast, screen reader labels)

Have an idea or need? Open an issue.
