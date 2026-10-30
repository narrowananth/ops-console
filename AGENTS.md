# AGENTS.md

README.md has project overview and commands. Be extremely concise; sacrifice grammar for concision.

## What this is

Ops Console: local web app on top of Claude Code. Shows connected MCP servers, services and their
Datadog health, database connections, open PRs and Claude sessions. The agent verifies a failing
route locally, the operator reviews, and only then does the agent fix and open a PR. Look and flows
come from `design/ops-console.html`.

## Layout

- `frontend/`: React 18 + Vite web UI.
- `backend/`: NestJS daemon: API, WebSocket, agent runtime, terminal, scheduled jobs. SQLite store.
- `cli/`: `ops-console` command (start, stop, status, open, logs, update, uninstall).
- `shared/`: TypeScript types both sides import: REST bodies, WebSocket events.
- `install.sh`: `curl … | sh` installer. Release tarballs from `.github/workflows/release.yml`.
- `design/`: Claude Design export. Source of truth for screens; open the HTML in a browser.
- `docs/specs/`: one spec per change, written by `/spec`, built by `/ship`.
- `docs/adr/`, `docs/architecture.md`, `GLOSSARY.md`: domain docs.

## Workflow

`/spec <description>` writes `docs/specs/<slug>.md`. `/ship <slug>` in a fresh session builds it
to an open GitHub PR. No Jira: the spec file is the record. The user merges; never run
`gh pr merge`.

## Skills to reach for

Module shape: `codebase-design`. Architecture sweep: `improve-codebase-architecture`. Diagram:
`diagram-design`. Hard bug: `diagnosing-bugs`. Datadog: `dd-pup`, `dd-logs`.

## Domain docs

Before design or code, read `GLOSSARY.md` and ADRs in `docs/adr/` touching the area.
`docs/architecture.md` maps modules and data flow.

- Use glossary terms exactly. Term missing or fuzzy: settle it, add it to `GLOSSARY.md`.
- Change contradicting an ADR: flag it, stop, ask. Approved, rewrite the ADR in place: the replaced
  design joins Considered Options with why it lost; git keeps the old text.
- New ADR only when decision is hard to reverse, surprising, and a real trade-off.
- Docs state current intent. No history; that goes in commit message.

## Invented requirements

A guard for a race or security case that no spec or ADR names is an invented requirement (shapes in
[CODING_STANDARDS.md](CODING_STANDARDS.md#invented-requirements)). Before writing one, tell the
user in words a 10-year-old follows: what goes wrong, how likely it is, how much code it adds.
Write it after their OK; until then the diff holds what was asked.

Agent safety rules in [ADR 0002](docs/adr/0002-operator-approves-agent-never-merges.md) and
[0003](docs/adr/0003-local-only-server.md) are not invented requirements: keep them.

## Prose

Prose written into this repo goes through `humanizer`. `CODING_STANDARDS.md` carries the rule in
full, plus naming, test and comment rules review enforces. Commit messages go through
`commit-message`.

Read `git diff --stat` before reporting work done, and report from it. Step meant and skipped reads
as taken otherwise, and nothing downstream catches it.

## Skills

Vendored in `.agents/skills/`, linked into `.claude/skills/`, upstream sources in
`skills-lock.json`. Committed copy is the pin. `spec`, `ship` and `commit-message` are local to this
repo. Add one: `npx skills add <source> --skill <name> -a universal -a claude-code`; commit lock
and files as one.

## Commands

pnpm workspace. Run from repo root. No Docker.

```
pnpm install
pnpm dev               # backend :4546, frontend :4545, data in backend/.data
pnpm dev:open          # open UI signed in to dev backend
pnpm check             # lint + typecheck + test, every package
pnpm db:generate       # Drizzle migration from backend/src/db/schema.ts
```

Installed app: `ops-console start | stop | status | open | logs | update | uninstall`.

## Public repo

`origin` is public on GitHub. No secrets, connection strings, internal hostnames, AWS account ids,
customer shop domains or people's emails in commits, specs, fixtures or screenshots. Use
`example.com`-style placeholders.

## Prod

Console may show PROD connections; agent treats them read-only unless the operator set write access
for that connection and approved the action. Command that writes to prod is the user's to run: name
it and stop.
