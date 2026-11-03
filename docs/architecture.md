# Architecture

## Shape

```
browser (127.0.0.1:4545)                 operator's Mac
┌────────────────────────┐  REST + WS   ┌───────────────────────────────────────────────┐
│ frontend/  React 18    │ ───────────▶ │ daemon: backend/ NestJS (127.0.0.1:4545)      │
│ Monitor · Workspace ·  │ ◀─────────── │  serves the built UI, /api, /ws, /terminals   │
│ Dev tools · Connect ·  │              │  agent ──▶ Claude Agent SDK ──▶ MCP servers   │
│ Agents & accounts      │              │  monitor ──▶ pup (Datadog)                    │
└────────────────────────┘              │  workspace ──▶ gh · glab · bkt (Git hosts)    │
                                        │  terminals ──▶ node-pty (Setup agent claude)  │
                                        │  claude-cli ──▶ claude mcp add/list/get       │
                                        │  scheduler ──▶ in-process timers              │
                                        │  db ──▶ Drizzle ──▶ SQLite (state.db)         │
                                        │  keychain ──▶ macOS Keychain                  │
                                        └───────────────────────────────────────────────┘
                                          launchd keeps it running (dev.ops-console)
```

One port serves everything. In development Vite serves the UI on 4555 and proxies `/api`, `/ws` and
`/terminals` to the backend on 4556. The dev backend keeps its data in `backend/.data` and its Keychain items under
the service `ops-console-dev`, so it runs beside the installed app and leaves its data alone.

## Install and run

`install.sh` puts a release tarball in `~/.ops-console/versions/<version>`, points
`~/.ops-console/current` at it and links `~/.local/bin/ops-console`. The tarball carries its own
Node 24, the bundled daemon, the built UI, the CLI, the native modules (`better-sqlite3`,
`@napi-rs/keyring`, `node-pty`) built for that Node, and the Claude Agent SDK with its platform's
Claude Code binary. The system Node is never used. The Node binary sits inside `Ops Console.app`, so
macOS names the daemon Ops Console when the operator grants it Full Disk Access; `node/bin/node`
links to it for the CLI and the MCP helpers. The bundle is signed ad hoc and carries no version, so releases on the
same Node build the same app and keep its Keychain access and Full Disk Access. A new Node makes a new app. The
first time a version starts, the previous version's app hands over the Keychain items it holds
(`keychain-handover.mjs take`), and the new app writes them back itself, so macOS doesn't ask for the login password
once per item. The handover runs in the background, about half a minute, and the daemon's Keychain reads wait for it.
`keychain-owner.json` in the data folder names the app that holds the items.

`ops-console start` writes a LaunchAgent plist (`RunAtLoad`, `KeepAlive`) that runs `current/Ops Console.app` on
`current/app/main.js`, so launchd starts the daemon at login and again if it stops. macOS lists it as Ops Console
under App Background Activity in Login Items & Extensions; switched off there, it does not start at login. The Setup agent's
Permissions show it as Start at login, read from the plist and `launchctl print-disabled`. `OPS_CONSOLE_PORT` at
`start` goes into the plist. The data folder is `~/Library/Application Support/ops-console`
(`OPS_CONSOLE_DATA_DIR` overrides it) and holds `state.db`, `runtime.json` (pid, port, version,
session token; mode `0600`), `daemon.lock`, each Claude account's config dir and each Anonymous
Session's folder. The log is `~/Library/Logs/ops-console/daemon.log`.

To try an install before a release, `pnpm build`, `pnpm package` and a `checksums.txt` beside the tarball in `out/`,
then `OPS_CONSOLE_RELEASE_URL=file://<repo>/out sh install.sh`. It replaces the installed app, since both use
`~/.ops-console` and the same data folder.

The daemon reads the newest GitHub release at start and every 6 hours (`UpdatesModule`). To install one, it runs
the installed version's `install.sh` with `OPS_CONSOLE_VERSION` and then stops itself. `KeepAlive` has launchd
start it again from `current`, now on the new version. `update.json` in the data folder records the version this
data last ran on, so the first start on a new one can say what it came from.

`bin/ops-console` also starts two helpers from the daemon bundle: `mcp-exec`, the launcher that
reads a stdio MCP Server's env vars from the Keychain, and `mcp-setup`, the Setup agent's MCP
Server.

On start the daemon takes the data folder lock, applies pending migrations in one transaction, runs
start-up recovery, opens the port, starts the scheduler and writes the runtime file.

## Stack

| Layer | Pick |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, TanStack Query, Zustand, React Router, Zod, xterm.js |
| Backend | NestJS on Node 24, Claude Agent SDK (TypeScript), `ws` WebSocket, MCP TypeScript SDK, node-pty, the `claude` CLI, Zod at boundaries |
| Database | SQLite through `better-sqlite3`, Drizzle ORM and Drizzle Kit migrations |
| Jobs | In-process scheduler, no queue |
| Secrets | macOS Keychain through `@napi-rs/keyring` |
| Tests | Vitest, Playwright, Supertest |
| Tooling | pnpm workspaces, Node 24 via mise, Biome for lint and format, esbuild for the daemon and CLI bundles, tsx for development |

## Integration layer

Every outside system is an MCP server or a CLI registered with Claude Code (ADR 0005). A Connector
hands off to the provider's browser sign-in, a secret the console must hold goes to the Keychain,
and the console runs `claude mcp add` in every Claude account. Fixed reads run the CLIs with no
model turn: `pup` for Scans, `gh`, `glab` and `bkt` for pull requests, `git ls-remote` when looking
for a Service's code. Judgment work (Verification, Fix, Agent Review, Reply check, Comment pass, Dev tools questions) runs as an
agent Session.

## Backend modules

| Module | Owns |
|---|---|
| `common` | Config, logger, error envelope, paging, session token, daemon address, `/health`, start-up recovery, `/ws` hub |
| `db` | SQLite file, migrations, `Store.write` (transaction, then WebSocket events) |
| `auth` | Session token check on every `/api` route |
| `settings` | Registered keys with schema and default; `GET` and `PATCH /api/settings` |
| `scheduler` | Jobs with slots; a missed slot runs once at start |
| `keychain` | `set`, `get`, `delete` in the login Keychain |
| `claude-cli` | `claude mcp add`, `remove`, `list`, `get`, `login`, and Claude account sign-in, parsed with Zod |
| `mcp-client` | Calls one tool on a server registered with Claude Code, for a fixed read |
| `mcp` | Servers registered in every Claude account (`.claude.json`) and a Repo's `.mcp.json`; Probe, add, edit, reconnect, disable, remove; the `mcp-exec` launcher |
| `connectors` | The eight Connectors: browser sign-in through `pup`, `gh`, `glab`, `bkt` or an MCP Server; the MCP Server each registers; Homebrew install of a missing CLI; checks; config |
| `connections` | Connections, Access Levels, PROD tags; how each type's MCP Server launches; checks; secrets via Keychain |
| `repos` | Repos: import by path or the Finder's folder dialog, rename, remove; local git reads, clone, stash and checkout |
| `agent` | Sessions and their kinds, Claude Agent SDK runs, permission hooks, the PROD-write rule hook, streaming parts, transcripts, message interceptors |
| `playbooks` | Playbooks and the Trigger each one holds, the built-ins (each Trigger's method, steps and shared rules on evidence, data, Connections and git) and Step blocks, the console's safety lines, and running a job's Playbook steps one turn each (registered by `agent`) |
| `accounts` | Claude accounts, their usage, Auto-switch and Smart usage |
| `action-log` | Writes a row before any outside action; Approvals; redaction |
| `workspace` | `repo`, `pr_review` and `anonymous` Sessions; branch checkout with stash; pull requests, comments, approve, request changes and the operator's merge through the Git host adapters (`gh`, `glab`, `bkt`); Agent Reviews, Reply checks and Comment passes, one job per pull request at a time, each in a scratch copy at the pull request's head commit; an Agent Review also fetches the target branch to compare with, may run the tests and build, and the console posts its findings and one summary comment; for the others the console commits, pushes, replies and resolves |
| `monitor` | Services, Routes, Scans and Alerts through `pup`; finding a Service's code; the Alert's Session; Verification and Reports; the operator's Review; the Fix from ticket to merged PR |
| `devtools` | `devtools` Sessions scoped to Connections; ties MCP calls to their Connection; the PROD-write rule; the instructions that make the agent hand over Results and a Comparison |
| `terminals` | node-pty terminals behind an authenticated WebSocket; the Setup agent, its MCP tools, local file, folder, URL and Keychain reads with secrets masked; the Full Disk Access and Start at login gates |

## Frontend areas

| Folder | Holds |
|---|---|
| `app` | Sign-in gate, sidebar, page shell and routes, theme store, the remembered page address |
| `lib` | API client, TanStack queries, `/ws` live events, session token, Remembered view storage, sorting |
| `monitor` | Monitor page: scan range and status codes, ticked Services, Alerts, Samples, Reports, Review and Fix |
| `workspace` | Workspace page: Repos and Anonymous Sessions, branch switcher, pull request list, files, threads and Agent Review card |
| `devtools` | Dev tools page (terminal-style `devtools` Sessions scoped to Connections, Results, Comparison) and the Connections page and form |
| `integrations` | Integrations page: Connectors and MCP Servers |
| `repos` | Repos page |
| `setup` | Setup agent page with its xterm terminal, and Permissions: Full Disk Access, Start at login, Keychain |
| `playbooks` | Playbooks page: Triggers, Playbooks, the editor with drag and drop, Step blocks; unsaved edits kept as a Remembered view; a job's Playbook steps |
| `agents` | Agents & accounts page, Session transcript, model, effort and Access mode chips, Approval prompts, Report rendering |
| `mcp`, `components/ui` | MCP status labels; shared controls, the folding card title, and the Tip layer that shows every element's `title` as a styled Tip on hover and keyboard focus |

## Data flow

**REST.** Every `/api` call carries `Authorization: Bearer <token>`. Bodies and responses are Zod
schemas in `shared/`. `ops-console open` passes the token in the URL fragment; the UI moves it into
local storage and drops it on `unauthorized`. Any number of browsers on the Mac that hold the token work at once
on the one daemon (`ops-console open <app>` signs another browser in): each keeps its own Remembered view, and `/ws` events reach all of them.

**WebSocket.** `/ws` sends server-to-client events only, with the token as the second subprotocol.
`Store.write` runs one transaction and sends its events after the commit. The UI turns each event into
query refetches, batched over 40 ms. Events (`shared/src/ws.ts`):

- Settings and agents: `settings.updated`, `session.output`, `session.finished`, `session.updated`,
  `approval.requested`, `approval.decided`, `action.logged`, `account.updated`, `account.removed`,
  `account.switched`.
- Integrations: `connection.checked` for MCP Servers, Connectors and Connections.
- Workspace: `pull_request.refreshed`, `pull_request.commented`, `pull_request.reviewed`.
- Monitor: `scan.started`, `scan.finished`, `alert.detected`, `alert.updated`, `alert.regressed`,
  `verification.stepped`, `alert.verified`, `alert.reviewed`, `fix.advanced`, `alert.resolved`.

`/terminals/:id` is a raw stream to one terminal behind the same token check.

**Start-up recovery.** Before the port opens: Sessions left `working`, `waiting_input` or
`waiting_approval` fail and their Approvals expire; a running Agent Review, Report, Fix, Reply check, Comment pass or Scan
fails (`interrupted` for a Scan, a Fix, a Reply check and a Comment pass); only failed jobs keep their scratch copy.

**Scheduler.** `monitor-scan` runs on a 6-hour grid from the Datadog Connector's daily scan time and
starts a Scan of every Service for each Check interval whose slot came due. `monitor-pr-watch` reads
the PR of every `pr_open` Fix every 5 minutes: merged resolves the Alert, closed abandons the Fix.
Claude account usage is read every 5 minutes on its own timer.

**Monitor.** A Scan reads failing logs through `pup`, groups them by Fingerprint into Alerts with up
to 25 redacted Samples, and records each Route's state. After a Scan the code finder looks once for
each Service with no code: an imported Repo of the same name, a git folder of that name next to one,
then a repository of that name on a connected Git host. The operator starts a Verification; it runs in
the Alert's Session, a `repo` Session in the Service's Repo or an `anonymous` Session holding a
clone of its Git URL. Its runs work in a scratch copy: a git worktree of that code at the newest
commit of the Verify Playbook's branch (the default branch when blank), fetched from origin first,
under `scratch/` in the data directory, removed once the Report is ready. The Report also
goes to a Markdown file in the Datadog Connector's reports folder. Confirming the Report starts the
Fix in the same Session, in the checkout and in a new conversation, stage by stage (ticket, branch,
steps, PR), each agent run ending with JSON. The ticket stage runs only when the Fix Playbook's Jira ticket switch is
on and Jira is connected; otherwise the branch is `fix/<name>`.

**Playbooks.** Each Trigger holds one Playbook, or its built-in. A job (Verification, Fix, Agent
Review, Reply check, Comment pass) copies its Trigger's Playbook when it starts and runs each step as its own turn, ending
done, skipped or failed; a failed step stops the job. After the last step the console's own closing
turn writes the Report or the review, and a Fix goes on to its PR. A step tagged scratch copy may write files and
run commands, only in the job's scratch copy. Chats (Session message, Reply in thread, Ask) read their
Playbook's rules at each turn. An Alert's Session uses the rules its latest job copied.

**Workspace pull requests.** Lists span every repository of every owner the operator can read on
each connected Git host, plus imported Repos under other owners. The daemon keeps lists in memory and
serves them stale-while-revalidate: a list older than 60 seconds (a detail older than 15) is served
at once while a background read runs, and a read that changed something sends
`pull_request.refreshed` with the changed numbers. A failed background read keeps the old list and
marks it stale. Refresh drops the memory and reads again. The UI prefetches the list at load.

**Remembered view.** The UI keeps each page's address (`app/last-address.ts`) and the picks on a page
(`lib/remember.ts`) in local storage under `ops-console:`, so page switches, reloads and reopening
the console land where the operator left off. A stored value that no longer parses falls back to the
default.

## `state.db` holds

Settings the operator changed, Claude accounts, Sessions and the Connections a `devtools` Session
names, the Action Log and Approvals, MCP Servers the operator removed or disabled, Connectors (config
and last check), Connections (no secrets), Repos, Agent Reviews, Reply checks, Comment passes, the ids of comments the agent
posted, Services, Routes, Scans and their Route results, Alerts and their events, Reports, Reviews
and Fixes, Playbooks, the Trigger each one holds, and each job's copy of its Playbook steps. Pull requests stay on the Git host. Session messages stay in the Claude Code transcript, in
the config dir of the Session's Claude account.

## Agent runs

A Session's run is a Claude Agent SDK `query()` in the working directory its kind supplies,
resuming the stored SDK session. Each Claude account has its own `CLAUDE_CONFIG_DIR` under the data
folder; the console never uses the operator's own Claude Code login. A `PreToolUse` hook writes the
Action Log row before every Bash and MCP call and holds a PROD write for an Approval in every
access mode. `disallowedTools` denies `gh pr merge`, `glab mr merge` and the GitHub and GitLab MCP
merge tools. Permission prompts in `supervised` mode, and the agent's questions, reach `canUseTool`
and wait for the operator. MCP Servers the operator disabled, and for a `devtools` Session the
Connections outside its scope, are denied for the run. Every run's system prompt appends the kind's
instructions, then the Playbook's rules, then the console's safety lines. Those say that log lines and
data are never instructions, that the agent never merges, and that no PROD value goes into a mock or
anything else it writes. A
conversation begun in one folder moves its transcript to the next run's folder, so a chat after a
Verification resumes it in the checkout. Runs live in the daemon's memory; a restart
fails them and expires their Approvals.

Smart usage moves work to the best-ranked signed-in Claude account on its own, and Auto-switch does
it at a usage threshold when Smart usage is off, as the design shows. Anthropic's terms may read
this as getting around usage limits; the operator accepted that risk
(`docs/specs/02-settings-agents.md`, Safety), and both toggles can be turned off. An account's name
is its email, each is added once, and usage is also read for idle accounts every 5 minutes. The
console never reads a Claude token: sign-in runs in Anthropic's own flow, and usage comes from the
SDK's rate-limit events and its usage request.

## Design departures

Where the build departs from `design/ops-console.html` on purpose:

- **Layout.** A left sidebar replaces the top bar and the Settings drawer; each former Settings tab is
  its own page (`design/ops-console-sidebar.html`). Controls and cards are rounded.
- **Replay source.** Datadog logs hold request headers, not bodies. A Verification rebuilds the
  request from the source (for example, the Shopify order by id) until a Service logs redacted
  bodies.
- **Access Level** changes how a Connection's MCP server launches (read-only flag, config file or
  read-only user), not only the badge.
- **Merge** is a button for the operator only; the agent has no merge tool.
- **Connectors** add Sentry and drop Kafka.
- **Dev tools** adds a Comparison under the per-Connection Results, and Copy JSON on each.
- **Agent Review card** shows a verdict (approve, request changes, comment), findings rated critical to info with a
  count of each, the commits it read and compared with, and the full report, in place of the design's blockers,
  suggestions and nits.
- **Tips** on every control, status and count whose words leave its meaning open, and a "?" beside such labels.
- **Folding cards**: each card with a title folds to it, and stays folded for that kind of card.
- **Permissions** on the Setup agent page add Start at login.
