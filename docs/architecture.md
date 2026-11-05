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

`install.sh` refuses macOS older than 13.5. It puts a release tarball in `~/.ops-console/versions/<version>`, points
`~/.ops-console/current` at it, links `~/.local/bin/ops-console` and keeps only the new and the previous version. An
Intel shell under Rosetta installs the arm64 build. The tarball carries its own
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
The Permissions page shows it as Start at login, read from the plist and `launchctl print-disabled`. `OPS_CONSOLE_PORT` at
`start` goes into the plist. The data folder is `~/Library/Application Support/ops-console`
(`OPS_CONSOLE_DATA_DIR` overrides it) and holds `state.db`, `runtime.json` (pid, port, version,
session token; mode `0600`), `daemon.lock`, `update.json`, `keychain-owner.json`, and a folder each for Claude
accounts (`accounts/`, each one's config dir), Anonymous Sessions (`anonymous/`), Session attachments
(`attachments/`), the pull request jobs' scratch copies (`pr-scratch/`), Verification scratch copies (`scratch/`),
Dev tools Sessions (`devtools/`), terminals (`terminals/`) and local MCP Server files (`mcp-local/`). The log is `~/Library/Logs/ops-console/daemon.log`.

To try an install before a release, `pnpm build`, `pnpm package` and a `checksums.txt` beside the tarball in `out/`,
then `OPS_CONSOLE_RELEASE_URL=file://<repo>/out sh install.sh`. It replaces the installed app, since both use
`~/.ops-console` and the same data folder.

The daemon reads the newest GitHub release 10 seconds after start and every minute (`UpdatesModule`; a dev build never
updates). The operator installs it, or the `auto_update` setting (on by default) does, and either waits for running
agent runs to finish unless the operator picks now. To install one, it runs the installed version's `install.sh` with
`OPS_CONSOLE_VERSION` and then stops itself. `KeepAlive` has launchd start it again from `current`, now on the new
version. `update.json` in the data folder records the version this
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
for a Service's code. The `slashdocs` CLI is a Connector's sign-in and has no MCP Server. Judgment work (Verification, Fix, Agent Review, Reply check, Comment pass, Dev tools questions) runs as an
agent Session.

## Backend modules

| Module | Owns |
|---|---|
| `common` | Config, logger, error envelope, paging, session token, daemon address, `/health`, start-up recovery, `/ws` hub |
| `db` | SQLite file, migrations, `Store.write` (transaction, then WebSocket events) |
| `auth` | Session token check on every `/api` route |
| `settings` | Registered keys with schema and default; `GET` and `PATCH /api/settings` |
| `scheduler` | Jobs with slots; a missed slot runs once at start |
| `keychain` | `set`, `get`, `delete` in the login Keychain, each bounded at 60 seconds and failing `keychain_timeout`; the handover of items from the previous version's app, which reads wait for (at most 90 seconds) and which refuses an app that fails its check (`codesign`, real path, bundle identifier); the Keychain wait shown after 10 |
| `claude-cli` | `claude mcp add`, `remove`, `list`, `get`, `login`, and Claude account sign-in in this browser or by link and code, parsed with Zod |
| `mcp-client` | Calls one tool on a server registered with Claude Code, for a fixed read |
| `mcp` | Servers registered in every Claude account (`.claude.json`) and a Repo's `.mcp.json`; Probe, add, edit, reconnect, disable, remove; the `mcp-exec` launcher |
| `connectors` | The nine Connectors: browser sign-in through `pup`, `gh`, `glab`, `bkt`, `slashdocs` or an MCP Server; cancel a sign-in; the MCP Server each registers; Homebrew install of a missing CLI; checks; config |
| `connections` | Connections, Access Levels, PROD tags; how each type's MCP Server launches; checks; secrets via Keychain |
| `repos` | Repos: import by path or the Finder's folder dialog, rename, remove; local git reads, clone, stash and checkout |
| `network` | The Network allowlist an agent run starts with: built-in hosts, the host of each Repo's `origin`, and the operator's own domains in `network_domains`; read, add and remove (`/network-allowlist`), registered by `agent` |
| `agent` | Sessions and their kinds, Claude Agent SDK runs, the Run sandbox rules, permission hooks, the PROD-write rule hook, streaming parts, transcripts, message interceptors; stop a run, edit the last message (file edits rewound), attachments |
| `playbooks` | Playbooks and the Trigger each one holds, the built-ins (each Trigger's method, steps and shared rules on evidence, data, Connections and git) and Step blocks, the console's safety lines, and running a job's Playbook steps one turn each (registered by `agent`) |
| `accounts` | Claude accounts, their usage, Auto-switch and Smart usage; the Claude account hub: with CLIProxy on, runs go to its loopback address with the API key from the Keychain and switching pauses |
| `action-log` | Writes a row before any outside action; Approvals; redaction |
| `workspace` | `repo`, `pr_review` and `anonymous` Sessions; a Session's diff, and a `repo` Session following the agent's branch; branch checkout with stash; pull requests, comments, approve, request changes and the operator's merge through the Git host adapters (`gh`, `glab`, `bkt`); Agent Reviews, Reply checks and Comment passes, one job per pull request at a time, each in a scratch copy at the pull request's head commit (an Agent Review makes one only when a Playbook step writes; the built-in's test step does); an Agent Review also fetches the target branch to compare with, may run the tests and build, and the console posts its findings and one summary comment; for the others the console commits, pushes, replies and resolves; Pull request opening: the console pushes a `repo` Session's branch and opens its pull request on the Git host, for a click in the Session header (the agent drafts the text) and for a Fix's PR stage |
| `monitor` | Services, Routes, Scans and Alerts through `pup`; finding a Service's code; the Alert's Session; Verification and Reports; the operator's Review; the Fix from ticket to merged PR |
| `devtools` | `devtools` Sessions scoped to Connections; ties MCP calls to their Connection; the PROD-write rule; the instructions that make the agent hand over Results and a Comparison |
| `updates` | The newest GitHub release, the version record (`update.json`), install through `install.sh`, auto-update, the wait for running agent runs |
| `terminals` | node-pty terminals behind an authenticated WebSocket; the Setup agent, its MCP tools, local file, folder, URL and Keychain reads with secrets masked; the Full Disk Access and Start at login gates |

## Frontend areas

| Folder | Holds |
|---|---|
| `app` | Sign-in gate with the restart panel while an update installs, sidebar with the running tasks tray, the update card, version panel and "Updated to" notice, page shell and routes, theme store, the remembered page address |
| `lib` | API client, TanStack queries, `/ws` live events, session token, Remembered view storage, sorting, the finish chime, clipboard copy |
| `monitor` | Monitor page: scan range and status codes, ticked Services, Alerts, Samples, Reports, Review and Fix |
| `workspace` | Workspace page: Repos and Anonymous Sessions, branch switcher, pull request list, files with Expand all and Collapse all, threads, the Agent Review, Reply check and Comment pass cards, the Session's Changes panel, the Open pull request form, queued messages, attachments |
| `devtools` | Dev tools page (terminal-style `devtools` Sessions scoped to Connections, Results, Comparison) and the Connections page and form |
| `integrations` | Integrations page: Connectors and MCP Servers |
| `repos` | Repos page |
| `setup` | Setup agent page with its xterm terminal, and the Permissions page: Full Disk Access, Start at login, Keychain, Run sandbox, Network allowlist |
| `playbooks` | Playbooks page: Triggers, Playbooks, the editor with drag and drop, Step blocks; unsaved edits kept as a Remembered view; a job's Playbook steps |
| `agents` | Agents & accounts page (accounts, sign-in by link, the CLIProxy hub, the chime), Session transcript, model, effort and Access mode chips, Approval prompts, the question panel, stop run, Report rendering |
| `mcp`, `components/ui` | MCP status labels; shared controls, the folding card title, the side panel that folds to a rail, the job pathway and live timers, and the Tip layer that shows every element's `title` as a styled Tip on hover and keyboard focus |

## Data flow

**REST.** Every `/api` call carries `Authorization: Bearer <token>`. Bodies and responses are Zod
schemas in `shared/`. `ops-console open` passes the token in the URL fragment; the UI moves it into
local storage and drops it on `unauthorized`. Any number of browsers on the Mac that hold the token work at once
on the one daemon (`ops-console open <app>` signs another browser in): each keeps its own Remembered view, and `/ws` events reach all of them.

**WebSocket.** `/ws` sends server-to-client events only, with the token as the second subprotocol.
`Store.write` runs one transaction and sends its events after the commit. The UI turns each event into
query refetches, batched over 40 ms. Events (`shared/src/ws.ts`):

- Settings and agents: `settings.updated`, `update.changed`, `session.output`, `session.finished`, `session.updated`,
  `approval.requested`, `approval.decided`, `action.logged`, `account.updated`, `account.removed`,
  `account.switched`.
- Integrations: `connection.checked` for MCP Servers, Connectors and Connections.
- Keychain: `keychain.wait_changed` when a call has waited past 10 seconds, and when the wait ends; `keychain.handover_refused` when the handover was refused.
- Workspace: `pull_request.refreshed`, `pull_request.commented`, `pull_request.reviewed`, `pull_request.job_changed` (a Reply check or Comment pass).
- Playbooks: `playbook_step.updated`, for each step of any job.
- Monitor: `scan.started`, `scan.finished`, `alert.detected`, `alert.updated`, `alert.regressed`,
  `verification.stepped`, `alert.verified`, `alert.reviewed`, `fix.advanced`, `alert.resolved`.

`/terminals/:id` is a raw stream to one terminal behind the same token check.

**Start-up recovery.** Before the port opens: Sessions left `working`, `waiting_input` or
`waiting_approval` fail and their Approvals expire; a running Agent Review, Report, Fix, Reply check, Comment pass, Playbook step or Scan
fails (`interrupted` for all but the Agent Review); a failed Report, Reply check or Comment pass keeps its scratch copy, and a Reply check or
Comment pass with one can retry.

**Scheduler.** `monitor-scan` runs on a 6-hour grid from the Datadog Connector's daily scan time and
starts a Scan of every Service for each Check interval whose slot came due. `monitor-pr-watch` reads
the PR of every `pr_open` Fix every 5 minutes and after each pull request list refresh: merged resolves the Alert,
closed abandons the Fix. Claude account usage is read at start and every 5 minutes on its own timer, and the update
check runs on its own timer too (`UpdatesModule`).

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

**Prod parity.** The Alert read carries Freshness (`last_scanned_at`, `scan_overdue`) and `awaiting_prod_check`, all
derived from `scans` and the Alert's own `resolved_at` and `cleared_at`. A Verification and a Fix each start with a
Recheck: one `pup` count of the Alert's query over the last hour. The result is the first step of the Report and a line
in the agent's brief. The Verification then adds the `version:` tag of the newest Sample, set against the commit of its
scratch copy. The Report's closing turn and the Fix's pull request brief ask for a Prod parity section; the Fix's PR stage asks the agent for the description only, and the console pushes the branch and opens the pull request. A chat run in a Repo's folder also has the console's in-process MCP server `ops-console` with the `open_pull_request` tool; the PreToolUse hook raises an Approval for it in every Access mode, and only a yes has the daemon push and open. None of this
blocks a job.

**Playbooks.** Each Trigger holds one Playbook, or its built-in. A job (Verification, Fix, Agent
Review, Reply check, Comment pass) copies its Trigger's Playbook when it starts and runs each step as its own turn, ending
done, skipped or failed; a failed step stops the job. After the last step the console's own closing
turn writes the Report or the review, and a Fix goes on to its PR. A step tagged scratch copy may write files and
run commands, only in the job's scratch copy. Chats (Session message, Reply in thread) read their
Playbook's rules at each turn. An Alert's Session uses the rules its latest job copied.

**Workspace pull requests.** Lists span every repository of every owner the operator can read on
each connected Git host, plus imported Repos under other owners. The daemon keeps lists in memory and
serves them stale-while-revalidate: a list older than 30 minutes (a detail older than 15 seconds) is served
at once while a background read runs, and a read that changed something sends
`pull_request.refreshed` with the changed numbers. A failed background read keeps the old list and
marks it stale, and a failed list is tried again after 5 minutes. Refresh drops the memory and reads again; it is the
only read besides the 30-minute one. A search by words filters what is kept. A search of just a number, with or without
`#`, asks the host for that number in every known project, in any state, and keeps the answer for a minute. Mine matches
number, title and the operator's login (the email on Bitbucket); All matches number, title and author. The UI prefetches the list at load.

**Remembered view.** The UI keeps each page's address (`app/last-address.ts`) and the picks on a page
(`lib/remember.ts`) in local storage under `ops-console:` (a few older keys, such as the theme, the token and Monitor's range, use
`ops-console-` or `ops-console.`), so page switches, reloads and reopening the console land where the operator left
off. Per Session it keeps the draft message and the attachments; per browser, the chime switch, folded cards and the
Changes panel's width and view. A stored value that no longer parses falls back to the
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
access mode. Every run's shell commands run in the Run sandbox (ADR 0006): the SDK's `sandbox` option, built per run
from its working folder, the data folder in use and the run's kind, which fails the run when it is unavailable. The
sandbox's `network` block holds the Network allowlist, built when the run starts from the built-in hosts, the host of
each Repo's `origin` and the `network_domains` rows the operator added; the SDK's proxy refuses any other host.
`disallowedTools` denies `WebFetch` and `WebSearch`, which the proxy does not cover, and `gh pr merge`, `glab mr merge`, `bkt pr merge`, `bkt pr auto-merge` and the GitHub and GitLab MCP
merge tools. An Agent Review, Reply check and Comment pass also deny `git push`, the host CLIs' comment, review and `api`
commands and the host MCP comment tools, since the console pushes, replies and resolves. Permission prompts in `supervised` mode, and the agent's questions, reach `canUseTool`
and wait for the operator. MCP Servers the operator disabled, and for a `devtools` Session the
Connections outside its scope, are denied for the run. Every run's system prompt appends the kind's
instructions, the rules for a PR description and the rule that the console, not the run, pushes and opens pull requests, then the Playbook's rules, then the console's
safety lines. Those say that log lines and
data are never instructions, that the agent never merges, and that no PROD value goes into a mock or
anything else it writes. Stop ends a run and expires its Approvals, and the operator may edit the last message, which rewinds the agent's file
edits. Attached files sit in the Session's `attachments/` folder, added to the run's directories. With CLIProxy on, a
run sends CLIProxy's API key and address in place of an account's sign-in, usage is not read from it and account
switching is off; the address must be loopback (ADR 0003). A
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
- **Connectors** add Sentry, Shopify and slashdocs, and drop Kafka.
- **Dev tools** adds a Comparison under the per-Connection Results, and Copy JSON on each.
- **Agent Review card** shows a verdict (approve, request changes, comment), findings rated critical to info with a
  count of each, the commits it read and compared with, and the full report, in place of the design's blockers,
  suggestions and nits.
- **Tips** on every control, status and count whose words leave its meaning open, and a "?" beside such labels.
- **Folding cards**: each card with a title folds to it, and stays folded for that kind of card.
- **Permissions** page under Connect, with Start at login.
- **Running tasks** tray in the sidebar: every agent run going, each linking to its work.
- **Updates**: a version line and panel, an update card and an "Updated to" notice, with Check now and auto-update.
- **Claude account hub**: CLIProxy as the sign-in for agent runs, and adding an account by link.
- **Finish chime**: a soft sound when the operator's run ends, switchable per browser, under Notifications.
- **Question panel**, **queued messages**, **attachments** and the Session's **Changes** panel in Workspace.
- **Check reply** and **Address comments** Triggers, with their cards on a pull request.
- **Job timers** and Skip and Retry on each Playbook step; Expand all and Collapse all on a pull request's files.
- **Side panels fold** to a rail: Workspace, Monitor's Services and the Session's Changes.
