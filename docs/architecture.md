# Architecture

## Shape

```
browser (localhost:4545)                 operator's Mac
┌────────────────────────┐  REST + WS   ┌──────────────────────────────────────────┐
│ frontend/  React 18    │ ───────────▶ │ backend/  NestJS (127.0.0.1:4546)        │
│ Monitor · Workspace ·  │ ◀─────────── │  agent ──▶ Claude Agent SDK ──▶ MCP      │
│ Dev tools · Settings   │              │  terminal ──▶ node-pty (claude, zsh)     │
└────────────────────────┘              │  monitor ──▶ pup (Datadog)               │
                                        │  workspace ──▶ simple-git, gh            │
                                        │  jobs ──▶ BullMQ ──▶ Redis               │
                                        │  db ──▶ Drizzle ──▶ Postgres             │
                                        │  secrets ──▶ macOS Keychain              │
                                        └──────────────────────────────────────────┘
```

## Stack

| Layer | Pick |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS + shadcn/ui, TanStack Query, Zustand, React Router, xterm.js, CodeMirror 6 (diffs), Recharts |
| Backend | NestJS on Node 24, Claude Agent SDK (TypeScript), node-pty over WebSocket, BullMQ on Redis, Slack Bolt (Socket Mode), GitHub via `gh` and Octokit, simple-git, `pup` for Datadog, Zod at boundaries |
| Database | Postgres 17 with Drizzle ORM and Drizzle Kit migrations |
| Queue | Redis 7 for BullMQ |
| Secrets | macOS Keychain through `@napi-rs/keyring` |
| Tests | Vitest, Testing Library, Playwright, Testcontainers |
| Tooling | pnpm workspaces, Node 24 via mise, Biome for lint and format |

## Backend modules

| Module | Owns |
|---|---|
| `mcp` | Reads `claude mcp list` and `~/.claude.json`; reconnect, disable, remove |
| `monitor` | Services, Routes, Scans, Alerts; Datadog queries through `pup` |
| `verification` | Runs a Verification with the agent, stores the Report |
| `review` | Operator's Review; on confirm, starts the fix Session |
| `workspace` | Repos, Sessions, branches, PRs through `gh` |
| `agent` | Claude Agent SDK runs, permission rules, streaming output |
| `terminal` | node-pty processes behind an authenticated WebSocket |
| `connections` | Connections, Access Levels, PROD tags; secrets via Keychain |
| `action-log` | Writes a row before any outside action |
| `auth` | Session token for the local server |

## Postgres holds

Repos, Services, Routes, Scans, Alerts, Reports, Reviews, Sessions and their messages, Connections
(no secrets), Action Log. Local dev runs it in `compose.yaml` on port 55432, away from other
projects' Postgres on 5432.

## Design departures

Where the build departs from `design/ops-console.html` on purpose:

- **Replay source.** Datadog logs hold request headers, not bodies. A Verification rebuilds the
  request from the source (for example, the Shopify order by id) until a Service logs redacted
  bodies.
- **Access Level** changes how a Connection's MCP server launches (read-only flag or read-only
  user), not only the badge.
- **Claude accounts.** One signed-in account per machine. The design's account rotation to stretch
  usage limits is out, pending a check of Anthropic's terms.
- **Merge** is a button for the operator only; the agent has no merge tool.
- **Connectors** add Sentry and drop Kafka.
