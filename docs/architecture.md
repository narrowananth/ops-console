# Architecture

## Shape

```
browser (127.0.0.1:4545)                 operator's Mac
┌────────────────────────┐  REST + WS   ┌──────────────────────────────────────────┐
│ frontend/  React 18    │ ───────────▶ │ daemon: backend/ NestJS (127.0.0.1:4545) │
│ Monitor · Workspace ·  │ ◀─────────── │  serves the built UI, /api and /ws       │
│ Dev tools · Settings   │              │  agent ──▶ Claude Agent SDK ──▶ MCP      │
└────────────────────────┘              │  terminal ──▶ node-pty (claude, zsh)     │
                                        │  mcp-client ──▶ MCP servers (fixed reads)│
                                        │  claude-cli ──▶ claude mcp add/list/get  │
                                        │  scheduler ──▶ in-process timers         │
                                        │  db ──▶ Drizzle ──▶ SQLite (state.db)    │
                                        │  keychain ──▶ macOS Keychain             │
                                        └──────────────────────────────────────────┘
                                          launchd keeps it running (dev.ops-console)
```

One port serves everything. In development Vite serves the UI on 4545 and proxies `/api` and `/ws`
to the backend on 4546.

## Install and run

`install.sh` puts a release tarball in `~/.ops-console/versions/<version>`, points
`~/.ops-console/current` at it and links `~/.local/bin/ops-console`. The tarball carries its own
Node 24, the bundled daemon, the built UI, the CLI, the native modules (`better-sqlite3`,
`@napi-rs/keyring`) built for that Node, and the Claude Agent SDK with its platform's Claude Code
binary. The system Node is never used.

`ops-console start` writes a LaunchAgent plist that runs `current/bin/ops-console daemon`. The data
folder is `~/Library/Application Support/ops-console` (`OPS_CONSOLE_DATA_DIR` overrides it) and
holds `state.db`, `runtime.json` (pid, port, version, session token; mode `0600`) and `daemon.lock`.
The log is `~/Library/Logs/ops-console/daemon.log`.

On start the daemon takes the data folder lock, applies pending migrations in one transaction, runs
start-up recovery, opens the port, starts the scheduler and writes the runtime file.

## Stack

| Layer | Pick |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Radix UI (dialog, tabs), TanStack Query, Zustand, React Router, Zod |
| Backend | NestJS on Node 24, Claude Agent SDK (TypeScript), `ws` WebSocket, MCP TypeScript SDK, the `claude` CLI, Zod at boundaries |
| Database | SQLite through `better-sqlite3`, Drizzle ORM and Drizzle Kit migrations |
| Jobs | In-process scheduler, no queue |
| Secrets | macOS Keychain through `@napi-rs/keyring` |
| Tests | Vitest, Playwright, Supertest |
| Tooling | pnpm workspaces, Node 24 via mise, Biome for lint and format, esbuild for the daemon and CLI bundles, tsx for development |

## Integration layer

Every outside system is an MCP server or a CLI registered with Claude Code (ADR 0005). A form
collects config, the secret goes to the Keychain, and the console runs `claude mcp add`. Fixed reads
(PR lists, Scan counts, health checks) go through `mcp-client` or the CLI with no model turn.
Judgment work (Verification, Fix, Agent Review) runs as an agent session.

## Backend modules

| Module | Owns |
|---|---|
| `common` | Config, logger, error envelope, paging, session token, start-up recovery, `/ws` hub |
| `db` | SQLite file, migrations, `Store.write` (transaction, then WebSocket events) |
| `auth` | Session token check on every `/api` route |
| `settings` | Registered keys with schema and default; `GET` and `PATCH /api/settings` |
| `scheduler` | Jobs with slots; a missed slot runs once at start |
| `keychain` | `set`, `get`, `delete` in the login Keychain |
| `claude-cli` | `claude mcp add`, `remove`, `list`, `get`, parsed with Zod |
| `mcp-client` | Calls a tool on a server registered with Claude Code |
| `mcp` | Reads `claude mcp list`; reconnect, disable, remove |
| `monitor` | Services, Routes, Scans, Alerts; Datadog queries through `pup` |
| `verification` | Runs a Verification with the agent, stores the Report |
| `review` | Operator's Review; on confirm, starts the fix Session |
| `workspace` | Repos, branches, PRs through `gh` |
| `agent` | Sessions, Claude Agent SDK runs, permission hooks, streaming output, transcripts |
| `accounts` | Claude accounts, their usage, Auto-switch and Smart usage |
| `terminal` | node-pty processes behind an authenticated WebSocket |
| `connections` | Connections, Access Levels, PROD tags; secrets via Keychain |
| `action-log` | Writes a row before any outside action; Approvals; redaction |

The first eight, plus `agent`, `accounts` and `action-log`, exist now; the rest arrive with their
specs.

## `state.db` holds

Settings the operator changed, Claude accounts, Sessions, the Action Log and Approvals, and, as
their specs land, Repos, Services, Routes, Scans, Alerts, Reports, Reviews and Connections (no
secrets). Session messages stay in the Claude Code transcript, in the config dir of the Session's
Claude account.

## Agent runs

A Session's run is a Claude Agent SDK `query()` in the working directory its kind supplies,
resuming the stored SDK session. Each Claude account has its own `CLAUDE_CONFIG_DIR` under the data
folder; the console never uses the operator's own Claude Code login. A `PreToolUse` hook writes the
Action Log row before every Bash and MCP call and holds a PROD write for an Approval in every
access mode. A `disallowedTools` rule denies merging. Permission prompts in `supervised` mode, and
the agent's questions, reach `canUseTool` and wait for the operator. Runs live in the daemon's
memory; a restart fails them and expires their Approvals.

Smart usage moves work to the best-ranked signed-in Claude account on its own, and Auto-switch does it at a usage threshold when Smart usage is off, as the design shows.
Anthropic's terms may read this as getting around usage limits; the operator accepted that risk
(`docs/specs/02-settings-agents.md`, Safety), and both toggles can be turned off. An account's name is its email, each is added once, and usage is also read for idle accounts every 5 minutes. The console never
reads a Claude token: sign-in runs in Anthropic's own flow, and usage comes from the SDK's
rate-limit events and its usage request.

## Design departures

Where the build departs from `design/ops-console.html` on purpose:

- **Replay source.** Datadog logs hold request headers, not bodies. A Verification rebuilds the
  request from the source (for example, the Shopify order by id) until a Service logs redacted
  bodies.
- **Access Level** changes how a Connection's MCP server launches (read-only flag or read-only
  user), not only the badge.
- **Merge** is a button for the operator only; the agent has no merge tool.
- **Connectors** add Sentry and drop Kafka.
