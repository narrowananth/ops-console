# Architecture

## Shape

```
browser (127.0.0.1:4545)        operator's Mac
┌────────────────────────┐  REST + WS   ┌─────────────────────────────────────────────────┐
│ frontend/  React 18    │ ───────────▶ │ daemon: backend/ NestJS (127.0.0.1:4545)        │
│ Operate: Monitor,      │ ◀─────────── │  serves the built UI, /api, /ws, and the        │
│   Workspace, Dev tools │              │  /terminals /browser /processes streams         │
│ Connect: Integrations, │              │  agent ──▶ Claude Agent SDK ──▶ MCP servers     │
│   Connections, Repos,  │              │  workspace ──▶ git · gh · glab · bkt            │
│   Setup agent,         │              │  monitor ──▶ pup · aws · Grafana · New Relic    │
│   Permissions          │              │              · Log folder (OTLP files)          │
│ Claude: Accounts &     │              │  browser ──▶ Chrome, headless, one per Session  │
│   Usage, Agent runs,   │              │  processes · terminals ──▶ node-pty             │
│   Playbooks, Skills    │              │  connectors · mcp · connections ──▶ claude CLI  │
│                        │              │  health-watch · scheduler · updates ──▶ timers  │
│                        │              │  db ──▶ Drizzle ──▶ SQLite (state.db)           │
│                        │              │  keychain ──▶ macOS Keychain                    │
└────────────────────────┘              └─────────────────────────────────────────────────┘
                                        launchd keeps it running (dev.ops-console)
```

One port serves everything. In development Vite serves the UI on 4555 and proxies `/api`, `/ws`, `/terminals`,
`/browser` and `/processes` to the backend on 4556. The dev backend keeps its data in `backend/.data` and its Keychain items under
the service `ops-console-dev`, so it runs beside the installed app and leaves its data alone.

## Install and run

`install.sh` refuses macOS older than 13.5. It puts a release tarball in `~/.ops-console/versions/<version>`, points
`~/.ops-console/current` at it, links `~/.local/bin/ops-console` and keeps only the new and the previous version. An
Intel shell under Rosetta installs the arm64 build. The tarball carries its own
Node 24, the bundled daemon, the built UI, the CLI, the native modules (`better-sqlite3`,
`@napi-rs/keyring`, `node-pty`) built for that Node, `playwright-core` and the Claude Agent SDK with its platform's
Claude Code binary. The system Node is never used. The Node binary sits inside `Ops Console.app`, so
macOS names the daemon Ops Console when the operator grants it Full Disk Access; `node/bin/node`
links to it for the CLI and the MCP helpers. The bundle is signed ad hoc and carries no version, so releases on the
same Node build the same app and keep its Keychain access and Full Disk Access. A new Node makes a new app. The
first time a version starts, the previous version's app hands over the Keychain items it holds
(`keychain-handover.mjs take`), and the new app writes them back itself, so macOS doesn't ask for the login password
once per item. The handover runs in the background and reads the keys listed in `keychain-manifest.json` directly and
in parallel; with no list yet, the previous app finds them by scanning the login keychain, once. A Keychain call waits
only for its own item, and `keychain-handover.pending` in the data folder, which holds the pid of the start moving the
items, makes a second start and `mcp-exec` wait for it. `keychain-owner.json` in the data folder names the app that
holds the items. `ops-console update` runs `install.sh` and then `launchctl kickstart -k` on the loaded job (a job not
loaded, or whose plist changed, is loaded again), so launchd starts the daemon once.

**Linux.** `install.sh` also installs `ops-console-linux-<arch>` on a glibc distribution, and the tarball carries a plain
`node/bin/node` and native modules compiled on a Linux runner of that architecture. `ops-console start` writes the
systemd user unit `ops-console.service` (`Restart=always`) and runs `systemctl --user enable --now`; `stop` runs
`disable --now`. The data folder is `${XDG_DATA_HOME:-~/.local/share}/ops-console` and the log
`${XDG_STATE_HOME:-~/.local/state}/ops-console/daemon.log`. Secrets live in the Secret Service under the same keys, with
no handover: a Linux start never runs `keychain-handover`, and with no Secret Service a save fails with
`invalid_state`. Agent runs do not start on Linux until the Run sandbox is verified there
([linux-port](specs/linux-port.md)), so the release workflow builds and smoke-tests the Linux tarballs and does not
publish them.

`ops-console start` writes a LaunchAgent plist (`RunAtLoad`, `KeepAlive`) that runs `current/Ops Console.app` on
`current/app/main.js`, so launchd starts the daemon at login and again if it stops. The job runs as `ProcessType` `Interactive`, so the Chrome of a
Session browser gets the priority of a foreground app. macOS lists it as Ops Console under App Background Activity in Login
Items & Extensions; switched off there, it does not start at login. The Permissions page shows that as Start at login, read
from the plist and `launchctl print-disabled`. The plist also sets the operator's `PATH` (so the daemon finds `claude`),
`OPS_CONSOLE_DATA_DIR`, `UV_THREADPOOL_SIZE=16` and `NODE_COMPILE_CACHE` (`~/.ops-console/compile-cache`, cleared by the
next install); `OPS_CONSOLE_PORT` at `start` goes into it too. The data folder is
`~/Library/Application Support/ops-console` (`OPS_CONSOLE_DATA_DIR` overrides it) and holds `state.db`, `runtime.json` (pid,
port, version, session token; mode `0600`), `daemon.lock`, `update.json`, `keychain-owner.json`, `keychain-manifest.json`,
and a folder each for Claude accounts (`accounts/`, each one's config dir), the git worktree of each `repo` Session
(`session-worktrees/`), Anonymous Sessions (`anonymous/`), Session attachments (`attachments/`), the files the agent writes
for the operator (`outputs/`, one folder per Session), each Session's Chrome profile (`browser/`), Verification scratch
copies (`scratch/`), Dev tools Sessions (`devtools/`), terminals (`terminals/`) and local MCP Server files (`mcp-local/`).
The log is `~/Library/Logs/ops-console/daemon.log`.

The CLI has `start` (waits 15 seconds for the daemon), `stop` (unloads and disables the job, so it stays down across
logins until the next `start`), `status` (exit code 3 when stopped), `open [app]`, `logs`, `update`, `uninstall` (keeps
data and logs) and `--version`.

Homebrew installs only the Brew entry command (`scripts/homebrew/entry.sh`, [ADR 0008](adr/0008-homebrew-installs-an-entry-command.md)):
the formula keeps the release tarball, its checksum and `install.sh` in its Cellar, and the first command, or the first
after `brew upgrade` brings a newer formula, runs that `install.sh` with `OPS_CONSOLE_NO_LINK` into `~/.ops-console`, and restarts a running daemon on the new version.
A tag `v*` runs `release.yml`: `build` packages one tarball per architecture on an arm64 and an Intel runner and starts
each under launchd, `publish` attaches both with `checksums.txt` to a GitHub release, and the
`tap` job renders the formula (`scripts/homebrew/render.mjs`), checks it from a local tap and commits it
to `Formula/ops-console.rb` on `main`, which is the tap.

To try an install before a release, `pnpm build`, `pnpm package` and a `checksums.txt` beside the tarball in `out/`,
then `OPS_CONSOLE_RELEASE_URL=file://<repo>/out sh install.sh`. It replaces the installed app, since both use
`~/.ops-console` and the same data folder.

The daemon reads the newest GitHub release 10 seconds after start and every 10 minutes (`UpdatesModule`; a dev build never
updates), and sends `update.changed` only when what the panel shows has moved. The operator installs it, or the `auto_update` field of the `updates` setting (on by default) does, and either waits for running
agent runs to finish unless the operator picks now. To install one, it runs the installed version's `install.sh` with
`OPS_CONSOLE_VERSION` and then stops itself. `KeepAlive` has launchd start it again from `current`, now on the new
version. `update.json` in the data folder records the version this
data last ran on, so the first start on a new one can say what it came from.

`bin/ops-console` also starts three helpers: `mcp-exec`, the launcher that reads a stdio MCP Server's env vars from the
Keychain, from `app/mcp-exec.js`, a bundle of the Keychain and the launcher alone, so a start does not load the daemon;
`google-mcp`, the Google bridge, from `app/google-mcp.js`, which holds no Keychain code and gets its Google client and
refresh token as env vars through `mcp-exec`; and `mcp-setup`, the Setup agent's MCP Server, from the daemon bundle.

On start the daemon takes the data folder lock, applies pending migrations in one transaction, runs
start-up recovery, opens the port, starts the scheduler, opens the start-up queue and writes the runtime file. On stop it logs how long each
provider's `onModuleDestroy` took; Probes and `claude` calls under way are aborted, and a registration or sign-in still
running after 5 seconds is left for the next start.

## Stack

| Layer | Pick |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, TanStack Query, Zustand, React Router, Zod, xterm.js |
| Backend | NestJS on Node 24, Claude Agent SDK (TypeScript), `ws` WebSocket, MCP TypeScript SDK, node-pty, `playwright-core` driving the operator's Chrome, the `claude` CLI, Zod at boundaries |
| Database | SQLite through `better-sqlite3`, Drizzle ORM and Drizzle Kit migrations |
| Jobs | In-process scheduler, no queue |
| Secrets | macOS Keychain, or the Secret Service on Linux, through `@napi-rs/keyring` |
| Tests | Vitest, Playwright, Supertest |
| Tooling | pnpm workspaces, Node 24 via mise, Biome for lint and format, esbuild for the daemon and CLI bundles, tsx for development |

## Integration layer

Every outside system is an MCP server or a CLI registered with Claude Code (ADR 0005). A Connector
hands off to the provider's browser sign-in, a secret the console must hold goes to the Keychain,
and the console runs `claude mcp add` in every Claude account. Fixed reads run the CLIs with no
model turn: `pup` and `aws` for Scans, the hosted Grafana Cloud and New Relic MCP servers for Loki and New Relic Scans (the daemon calls their tools itself, with its own Grafana token or the New Relic sign-in it reads from Claude Code; or, for New Relic with a User API key from the Keychain, New Relic's own API through `connectors/new-relic-api.ts`), `gh`, `glab` and `bkt` for pull requests, a `bkt` repository list (or `git ls-remote`
when the list cannot be read) when looking for a Service's code. The `slashdocs` CLI is a Connector's sign-in and has no MCP Server; the Google Connectors register the console's own Google bridge. Judgment work (Verification, Fix, a PR action, Dev tools questions) runs as an
agent Session.

## Backend modules

| Module | Owns |
|---|---|
| `common` | Config, logger, error envelope, paging, session token, daemon address, `/health`, the data folder lock and runtime file, start-up recovery, the start-up queue, the `/ws` hub (the streams `/terminals`, `/browser` and `/processes` take their upgrade through it), the git and host CLI process pools, bounded waits, event-loop stall warnings, shutdown timing |
| `db` | SQLite file, migrations, `Store.write` (transaction, then WebSocket events) |
| `auth` | Session token check on every `/api` route |
| `settings` | Registered keys with schema and default (`session_defaults`, `agent_accounts`, `cliproxy`, `updates`, `health_checks`); `GET` and `PATCH /api/settings` |
| `scheduler` | Jobs with slots (`monitor-scan` for Datadog and `monitor-scan-<connector>` for each other log source, `monitor-pr-watch`, `monitor-retention`); a missed slot runs once at start, in the start-up queue |
| `keychain` | `set`, `get`, `delete` in the login Keychain, each bounded at 60 seconds and failing `keychain_timeout`, two native calls at a time, values kept in memory; the handover of items from the previous version's app, per key, which a read waits for (at most 90 seconds) and which refuses an app that fails its check (`codesign`, real path, bundle identifier); the Keychain wait shown after 10, and a call made while it shows fails at once |
| `claude-cli` | `claude mcp add`, `remove`, `list`, `get`, `login`, and Claude account sign-in in this browser or by link and code, parsed with Zod |
| `mcp` | Servers registered in every Claude account (`.claude.json`: `claude mcp` in the active account, the entry copied into the others) and a Repo's `.mcp.json`; Probe of the active account, kept 5 minutes (another account's when it becomes active, or after 10), after the Keychain handover; add, edit, reconnect (one server alone), disable, remove; the `mcp-exec` launcher; the Google bridge, a stdio MCP Server the Google Connectors register, whose tools (`google-tools.ts`) call Google's REST APIs with an access token it mints from the refresh token `mcp-exec` hands it |
| `connectors` | The sixteen Connectors: browser sign-in through `pup`, `gh`, `glab`, `bkt`, `slashdocs` or an MCP Server; cancel a sign-in; the MCP Server each registers; Homebrew install of a missing CLI; checks; config. Google Docs, Sheets and Drive sign in through the console's own Google OAuth client and register the Google bridge. OpenTelemetry logs has a Log folder, chosen in the macOS folder dialog, in place of a sign-in. CloudWatch logs has an AWS profile chosen from the profiles on the Mac, a region and Log groups; it signs in with `aws login` or `aws sso login`, the daemon calls `aws`, and the agent's CloudWatch MCP Server starts through `uvx`. Loki logs signs in to Grafana Cloud through the daemon (the MCP SDK's OAuth client, a loopback page for one callback, the tokens in the Keychain), picks a Loki data source, registers Grafana's MCP Server for the agent and has the daemon call its tools. New Relic logs has a Region, signs in through Claude Code to the MCP Server of that Region, picks an account, and has the daemon call the server's tools with the sign-in it reads from Claude Code's own item in the Keychain and never refreshes; with a User API key from the Keychain it calls New Relic's own API instead (`new-relic-api.ts`) |
| `connections` | Connections, Access Levels, PROD tags; how each type's MCP Server launches; checks, through one kept server per Connection for 5 minutes; secrets via Keychain, `secret_stored` from memory; a Kafka Connection saves with Access Level `none` only, since no MCP Server launches for it yet |
| `repos` | Repos: import by path or the Finder's folder dialog, rename, remove; local git reads, clone, stash, worktrees and checkout; a branch list answers from the last fetch and asks origin after, once a minute at most, then sends `repo.branches_changed` when a branch came or went; each Repo's host and `owner/name` read again from `origin` at start and in the background after a list (at most once a minute), and mapped to the Git host's new owner when the host renames one (`origin` is never edited); a Repo's branch and changes come from one `git status`, kept 10 seconds, eight Repos at a time |
| `agent` | Sessions and their kinds, Claude Agent SDK runs, the Run sandbox settings (`run-sandbox.ts`) and the file-tool denials, permission hooks, the PROD-write rule hook, streaming parts, transcripts, message interceptors; stop a run, edit the last message (file edits rewound), attachments, output files, the console's in-process MCP server `ops-console` with its tools (`open_pull_request`, `join_repo`, `spawn_sessions`, `run_integration`, `save_file`, `query_new_relic`, `submit_*`, `browser_*`, `start_process`, `process_output`, `stop_process`; `session-tools.ts`), and which MCP servers a run starts (`mcp-scope.ts`); the integration CLIs run in the daemon outside the sandbox; every tool call of a run kept with its time (`run_steps`), each subagent (`run_agents`) and each run's cost (`run_usage`), pruned after 90 days; run health, slow and failure reasons, stages and time split read from them; the message queued behind a run; a skill message, which hands the run its skill in place of the Playbook; the `/` and `$` menu data (`/skill-menu`) |
| `playbooks` | Playbooks and the Trigger each one holds, the built-ins (each Trigger's method, steps and shared rules on evidence, data, Connections and git) and Step blocks, the console's safety lines, and running a job's Playbook steps one turn each; Custom Skills, the Built-in skills in their Skill packs (a catalog in code, the installed packs in `state.db`), the `/skills`, `/skill-packs` and `/skill-menu` routes, the Project skills read from a Repo's folder for the menu, and the Skills each Playbook holds (registered by `agent`) |
| `accounts` | Claude accounts, their usage, Auto-switch and Smart usage; the Claude account hub: with CLIProxy on, runs go to its loopback address with the API key from the Keychain and switching pauses. Account usage is served by `/agent-accounts/usage` |
| `action-log` | Writes a row before any outside action; Approvals; redaction |
| `workspace` | `repo`, `pr_review` and `anonymous` Sessions; each `repo` Session in a git worktree of its own under `session-worktrees/` in the data directory, made at once from the default branch as last fetched and moved to origin's newest in the background; a Session's diff read from its worktree, and a `repo` Session following the branch its worktree is on; branch checkout with stash, in the worktree; a Session starts on any branch (one the Repo's own folder holds starts detached at its commit; a branch only `origin` has is fetched; a new name is made at the newest default branch); commit, push and open-folder routes of a Session; `join_repo` and `spawn_sessions` for Anonymous and `repo` chats; the file list behind the composer's `@` menu (`/file-menu`); pull requests, their commits and a conflict check, comments, approve, request changes and the operator's merge through the Git host adapters (`gh`, `glab`, `bkt`); PR action Sessions (Address comments, Check replies, Review with agent): a `repo` Session per press, one unsubmitted per pull request and action, in a detached worktree at the pull request's head commit, fetched from `origin`, that ends in one console tool call (`submit_thread_results`, `submit_reply_verdicts` or `submit_review`) that the daemon turns into the commit and push (Address comments only), the replies and resolves, or the review's findings and summary comment, as the operator; a review also records the commit it read and the target branch commit it compared with; Pull request opening: the console pushes a `repo` Session's branch and opens its pull request on the Git host, for a click in the Session header (the text is drafted at once from the branch's commits, with no agent run) and for a Fix's PR stage; the base check and the push run side by side |
| `monitor` | Services, Routes, Scans and Alerts, read through one reader per log source (`pup` for Datadog, OTLP files, `aws` Logs Insights, Grafana's and New Relic's MCP tools or New Relic's API; a few searches at once); each source's Scan schedule; retention of Alerts, Scans and Alert events; finding a Service's code; the Alert's Session; Verification and Reports; the operator's Review; the Fix from ticket to merged PR |
| `browser` | A Session's Browser panel: the operator's Google Chrome (`OPS_CONSOLE_CHROME_PATH` names another) run headless through `playwright-core`, one Chrome and profile folder (`browser/<session>`) per Session, started with its first tab and stopped after 10 idle minutes; tabs in memory; the page streamed as binary JPEG frames (quality 60, every screencast frame, with the pixels of the page's size times the viewer's pixel ratio) over `/browser/:tabId`, each frame acknowledged to Chrome once the socket took it, viewer sizes taken one per frame Chrome draws (the newest wins), with input sent back; the outside hosts a page called; the agent's `browser_*` tools (`browser_open`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_evaluate`, `browser_console`, `browser_network`), held to loopback pages; the Inspector's relay on `/browser/:tabId/devtools` (`inspector-relay.ts`: a CDP session of its own per window, a method allowlist, at most three windows per tab, closed with the tab, the Session or the daemon); the Element pick (`element-picker.ts` and `element-capture.ts`, on the tab's own CDP session: a viewer in pick mode sends `pick` messages over `/browser/:tabId`, the daemon finds the node with `DOM.getNodeForLocation` plus the page's scroll offset, outlines it with `Overlay.highlightNode`, which shows in the screencast, and on a click reads it with one function run on the node, the accessibility tree for role and name, `redact` over every string, and a `Page.captureScreenshot` clip for the crop, sent back as `picked` to the clicking viewer only) |
| `processes` | Session processes: commands the daemon runs as the operator, outside the Run sandbox, in a Session's worktree through node-pty, kept in `session_processes` and in memory, streamed over `/processes/:id` in 8 ms batches; the login environment, read once from the login shell and kept until an rc file changes (`login-env.ts`); the scan for Local servers (`lsof`, shared with the process table); a Session's `package.json` scripts; the agent's `start_process`, `process_output` and `stop_process` |
| `devtools` | `devtools` Sessions scoped to Connections; ties MCP calls to their Connection; the PROD-write rule; the instructions that make the agent hand over Results and a Comparison |
| `updates` | The newest GitHub release, the version record (`update.json`), install through `install.sh`, auto-update, the wait for running agent runs |
| `health-watch` | Checks of Connections, Connectors and MCP servers on a schedule per area (`health_checks`: every 30 minutes to 24 hours, or off; Connections 2 hours and Integrations 1 hour by default), two at a time, the operator's own check going first; every `connection.checked` kept in `health_checks` (a `connection.checked` of the same answer within 30 seconds is one row; 90 days kept); sends `health.changed` once when an item breaks or recovers; `GET /health-watch`, `POST /health-watch/:area/checks` |
| `terminals` | node-pty terminals behind an authenticated WebSocket; the Setup agent, its MCP tools, local file, folder, URL and Keychain reads with secrets masked; the gates behind the Permissions page: Full Disk Access (macOS), Start at login (launchd, or a systemd user service with its lingering state), whether the Run sandbox works (`sandbox-exec` on macOS; bubblewrap, socat and user namespaces on Linux), whether secrets can be stored (`GET /terminals/keychain`), the Keychain wait and handover state |

`agent`, `playbooks`, `accounts` and `action-log` are one Nest module (`AgentModule`); `main.ts` lists the others.

## Frontend areas

| Folder | Holds |
|---|---|
| `app` | Sign-in gate with the restart panel while an update installs, sidebar with the running tasks tray, the Keychain wait banner, the update card, version panel and "Updated to" notice, page shell and routes (each page's code loads when its route opens), theme store, the remembered page address |
| `lib` | API client (a few large lists check only their first and last items), TanStack queries, `/ws` live events and the waits on them, session token, Remembered view storage, the page a link came from (`return-to.ts`), sorting, the finish chime, clipboard copy |
| `monitor` | Monitor page: a header with how the Scans went (a source with something to say opens its detail), the range, HTTP status codes and the Scan button; one tab per log source after All sources, each with its open Alerts by tier; the Services menu (ticked Services are the next Scan); the alerts table (100 rows at a time, a search, Trend bars, Freshness); the Alert drawer, over the right of the page and widened by dragging its edge, with Samples, Reports, Review and Fix; the log source label on each Alert and Service |
| `agent-runs` | Agent runs page: run health, why a run is slow or ended, time split, timeline, steps, queued messages, desktop alerts |
| `browser` | The Session's Browser panel (tabs, toolbar, the drawn page, device menu, Local servers), a tab in a window of its own (`/browser-window/:sessionId/:tabId`, opened from the toolbar, a second viewer of the tab, the panel holds a placeholder for it while it is open), the Inspector (Inspect docks DevTools in the panel, under the page or beside it, in an iframe of `/devtools-frontend/devtools_app.html?ws=<host>/browser/<tab>/devtools`, or opens that address in a popup window; `InspectorLayout` keeps the page in its own area so its Fill size follows; Chrome's DevTools built by `scripts/devtools-frontend.mjs` into `frontend/public/devtools-frontend`; `devtools-socket.js` runs ahead of it and adds the token to its socket from local storage), the Terminals dock (an icon-first bar: the selected process, New terminal, a scripts and folder menu, Split, Restart, Delete (a running process is stopped first), Maximize and Hide; a Delete on each row of the list; one xterm per Session process, a Split showing a second shell beside the first, a list of processes on the right once there is more than one, a drag handle for its height), the header buttons, and loopback links in the transcript that open in the panel; the toolbar's icon buttons (no menu), and pick mode in `PageStage` (the pointer sends `pick` messages and not mouse ones; a pick goes to `element-picks.ts`, which keeps it in local storage under the Session until the composer takes it, so a tab's window reaches the console page's composer; the composer's `picked-elements.tsx` attaches the crop through the attachment upload and adds one `<picked-element>` block per pick to the message, which the transcript draws as a card) |
| `workspace` | Workspace page: the Sessions inbox (Needs you, Running, Idle; filter tabs, Repo picker, + New with a Repo and branch picker), the pull request list grouped by next step (project picker, Mine, Others and All; GitLab's open on GitLab), a pull request's page (Overview, Files changed and Commits tabs, a sidebar of folding sections with the checks, five merge checks, people, threads and Sessions, the conflict box), files with Expand all and Collapse all, threads, the PR action Sessions in the Sessions section, the Session card (a side panel with the Session's pull requests and its subagents under Lineage), the Session's Changes panel, Copy and Fork from this response under each finished agent response (`SessionForks` slices the transcript at the next operator message and gives the new Session its own SDK session id), the subagent row above the composer, the Sessions list's hover card with each Session's pull requests, the Open pull request form, the Repos chip, queued messages, attachments, output file chips on the turn that wrote them, the composer's `$` skills, `/` commands and `@` files menus, the batch card of a `spawn_sessions` call and the skill chip on a skill message |
| `devtools` | Dev tools page (terminal-style `devtools` Sessions scoped to Connections, Results, Comparison) and the Connections page and form |
| `integrations` | Integrations page: Connectors and MCP Servers, each with its Connect, Cancel, Check and Disconnect, the sign-in hand-off pane, and one pane per log source (the Log folder picker, the CloudWatch profile, region and Log group pickers, the Loki data source picker, the New Relic Region, account picker and User API key field) |
| `health` | The check strip, the problem banner and the history stripe at the top of Integrations and Connections, the failing and Recovered pills, and the interval picker |
| `repos` | Repos page |
| `setup` | Setup agent page with its xterm terminal, and the Permissions page: Full Disk Access, Start at login, Keychain, Run sandbox |
| `playbooks` | Playbooks page: the overview of Triggers (each on its built-in or the operator's Playbook, chosen from a dropdown), New Playbook (Blank or Copy of a built-in), the Playbook as a flow on a canvas with a panel the operator resizes, Step blocks by drag, + or Alt and arrow keys, the Rules and Skills token meters, the Skills a Playbook holds; unsaved edits kept as a Remembered view; a job's Playbook steps and the Skills it was offered |
| `skills` | Skills page: Discover first (Skill packs, Install and Uninstall, each pack's skills read-only, the Playbooks holding each) and Yours (Custom Skills and their editor, with New Skill); unsaved edits kept as a Remembered view |
| `agents` | Accounts & Usage page (accounts, sign-in by link, the CLIProxy hub, the chime), Session transcript, model, effort and Access mode chips, Approval prompts, the question panel, stop run, Report rendering |
| `mcp`, `components/ui` | MCP status labels; shared controls, the folding card title, the side panel that folds to a rail, the job pathway and live timers, and the Tip layer that shows every element's `title` as a styled Tip on hover and keyboard focus, the code block with its copy icon, and the file viewer |

**Rendering and loading.** The Session's composer holds the draft, so a key redraws the composer and not the conversation. Messages are memoized and the older ones carry `content-visibility: auto`; the Markdown parse is kept per text. The conversation map reads which messages are in view from an `IntersectionObserver`. A pull request file with a long diff draws its lines once it nears the screen, and the Dropdown draws at most 100 options. A sent message shows in the transcript at once and the composer empties at the click; the daemon's copy replaces it on the next read. Opening a Session, and the first key in its composer, ask the daemon to start the agent (`POST /sessions/:id/warm`) at most once a minute. The build splits React, the router, TanStack Query and Zod into vendor files; xterm loads with the Terminals dock or the Setup page.

**Guardrails.** `biome check` runs the plugins in `tools/biome`, which fail a mutation callback that returns `invalidateQueries`. `backend/test/perf-budget.test.ts` holds every plain list to a time and size budget on a busy store.

## Data flow

**REST.** Every `/api` call carries `Authorization: Bearer <token>`. Bodies and responses are Zod
schemas in `shared/`. `ops-console open` passes the token in the URL fragment; the UI moves it into
local storage and drops it on `unauthorized`. Any number of browsers on the Mac that hold the token work at once
on the one daemon (`ops-console open <app>` signs another browser in): each keeps its own Remembered view, and `/ws` events reach all of them.

**WebSocket.** `/ws` sends server-to-client events only, with the token as the second subprotocol.
`Store.write` runs one transaction and sends its events after the commit; `Store.emit` sends an event with no state change behind it. A run's `session.output` goes out at most every 100 ms, each changed part whole; a text over 8,000 characters goes out every 400 ms and one over 32,000 every second. A client with over 1 MB waiting to send gets only the newest `session.output` of each part until its queue drains; every other event goes out in order. The UI turns each event into
query refetches, batched over 40 ms. A `session.output` event puts its part into the cached transcript; the transcript is read again only when the part cannot be placed (a part before it is missing) and when the run finishes. A run's steps and edits read the Session's diff and the run list at most every 4 and 5 seconds, `session.updated` the Session lists and the diff every 1.5 seconds, and the pull request lists every 5 seconds. Pages poll nothing else while an event covers them: the Accounts page reads its lists every 10 seconds, every other page every minute. The socket reopens after a drop and the UI reads every query again. Events (`shared/src/ws.ts`):

- Settings and agents: `settings.updated`, `update.changed`, `session.output`, `session.finished`, `session.updated`,
  `approval.requested`, `approval.decided`, `action.logged`, `account.updated`, `account.removed`,
  `account.switched`.
- Integrations: `connection.checked` for MCP Servers, Connectors and Connections; `health.changed` when a scheduled or manual check turns a working item into a failing one or back.
- Keychain: `keychain.wait_changed` when a call has waited past 10 seconds, and when the wait ends; `keychain.handover_refused` when the handover was refused.
- Browser and processes: `browser.tabs_changed`, `browser.servers_changed`, `process.changed`, `process.removed`.
- Workspace: `repo.branches_changed`, `pull_request.refreshed`, `pull_request.commented`, `pull_request.reviewed`, `pull_request.action_changed` (a PR action Session started, ran, or submitted).
- Playbooks: `playbook_step.updated`, for each step of any job; `skills.changed`, when a Skill is created, edited or deleted, or a Skill pack is installed or uninstalled.
- Monitor: `scan.started`, `scan.finished`, `alert.detected`, `alert.updated`, `alert.regressed`,
  `verification.stepped`, `alert.verified`, `alert.reviewed`, `fix.advanced`, `alert.resolved`.

`/terminals/:id` is a raw stream to one terminal behind the same token check. `/browser/:tabId` (frames out, input and pick messages in, a picked element out), `/browser/:tabId/devtools` (the DevTools protocol, to the Inspector) and `/processes/:id` (output out, input in) are the same kind of stream, with the same check.

**Start-up recovery.** Before the port opens: Sessions left `working`, `waiting_input` or
`waiting_approval` fail and their Approvals expire; a running Report, Fix, Playbook step or Scan
fails (`interrupted`); a failed Report keeps its scratch copy. Any folder left under `pr-scratch` is removed after the port opens, and Keychain items of retired log source sign-ins are deleted.

**Start-up queue.** The daemon is one thread, so work a start would begin all at once waits its turn: the first MCP
Probe, the first usage read and CLIProxy check, the sweep of leftover Skill folders and the scans and jobs a stopped
daemon missed. Each service adds its task in `onApplicationBootstrap`. Three seconds after the port opens the queue runs
them in the order added, two at a time with a second's rest after each, so the page's first requests are answered
before any of it begins. A task that fails logs a warning and the rest go on. Tests open the queue at once.
Playwright loads with the first browser tab, not at start. The sidebar badge counts open Alerts from the
`alerts_summary_idx` index alone.

**Scheduler.** `monitor-scan` (Datadog) and `monitor-scan-<connector>` (each other log source) run on a 6-hour grid from that Connector's daily scan time and
start a Scan of every Service of that source for each Check interval whose slot came due. `monitor-pr-watch` reads
the PR of every `pr_open` Fix every 5 minutes and after each pull request list refresh: merged resolves the Alert,
closed abandons the Fix. Claude account usage is read at start and every 5 minutes on its own timer, and the update
check and `health-watch` run on their own timers too (`UpdatesModule`, `HealthWatchModule`); the agent's retention sweep runs daily. `monitor-retention` runs daily and after a Scan, at most hourly (see Monitor).

**Monitor.** A Scan reads failing logs through `pup`, from the OpenTelemetry Log folder's OTLP JSON files (read only, 100 MB per Scan, newest first), from CloudWatch Log groups through `aws` and Logs Insights (JSON lines only, at most 10,000 Samples per Log group, 5 minutes per query), from Loki through Grafana Cloud's MCP server (JSON lines, 100 lines per call, paged to at most 5,000 Samples per Service), or from New Relic through its MCP server and NRQL (at most 5,000 Samples per Service), groups them by Fingerprint into Alerts with up
to 25 redacted Samples, and records each Route's state. The Scan is stored 25 failure groups at a time, with a turn of the event loop between, so a large Scan never holds the daemon. After a Scan the code finder looks, two Services at a time, for
each Service with no code it did not look for in the last week (`services.code_looked_at`): an imported Repo of the same name, a git folder of that name next to one,
then the imported Repo whose tracked source holds the Service's Route paths (`git grep`, tests and docs left out; a tie is left unlinked), then a repository of that name on a connected Git host, read from one list of the Bitbucket workspace's repositories rather than one `git ls-remote` each. The operator starts a Verification; it runs in
the Alert's Session, a `repo` Session in the Service's Repo or an `anonymous` Session holding a
clone of its Git URL. Its runs work in a scratch copy: a git worktree of that code at the newest
commit of the Verify Playbook's branch (the default branch when blank), fetched from origin first,
under `scratch/` in the data directory, removed once the Report is ready. The Report also
goes to a Markdown file in the log source Connector's reports folder. Confirming the Report starts the
Fix in the same Session, in its worktree and in a new conversation, stage by stage (ticket, branch,
steps, PR), each agent run ending with JSON. The ticket stage runs only when the Fix Playbook's Jira ticket switch is
on and Jira is connected; otherwise the branch is `fix/<name>`.

**Alert list and retention.** `GET /alerts` lists the Alerts not resolved or dismissed, without the Alert's source query and with `log_line` cut to 300 characters; the detail keeps both whole. `scope=closed` lists the resolved and dismissed ones a page at a time (`limit`, `cursor`), and the Monitor reads them only once the operator ticks Closed. `GET /alerts/summary` counts the open ones. An open Alert that no Scan has seen for 14 days is resolved with an `auto_resolved` Alert event; a failing Scan later reopens it as a Regression. Scans, their Route results and Alert events older than 30 days are deleted in small batches, except the newest `ok` Scan that read each Service and the events of an Alert a Verification or Fix is working on. The Action Log is never pruned.

**Prod parity.** The Alert read carries Freshness (`last_scanned_at`, `scan_overdue`) and `awaiting_prod_check`, all
derived from `scans` and the Alert's own `resolved_at` and `cleared_at`. A Verification and a Fix each start with a
Recheck: one `pup` count of the Alert's query over the last hour. The result is the first step of the Report and a line
in the agent's brief. The Verification then adds the `version:` tag of the newest Sample, set against the commit of its
scratch copy. The Report's closing turn and the Fix's pull request brief ask for a Prod parity section; the Fix's PR stage asks the agent for the description only, and the console pushes the branch and opens the pull request. A chat run in a Session worktree also has the console's in-process MCP server `ops-console` with the `open_pull_request` tool; it asks for no Approval, and the daemon pushes the branch, rebases it onto a branch that moved on `origin` (never forced) and opens the pull request, or pushes to the one already open. An Anonymous Session's run in the same server has a `join_repo` tool instead, with the same Approval in every Access mode (`anonymous-joins-repo`). A chat the operator started in an Anonymous or `repo` Session that no Alert made and no other Session spawned also has `spawn_sessions`: one Approval in every Access mode for the whole list, then the daemon makes a `repo` Session per entry (its `spawned_by_session_id` and the call's tool-use id kept in `state.db`) and starts each run at once, with no cap (`spawn-parallel-sessions`). The transcript shows the call as a batch card read from those Sessions. A run the operator started also has `run_integration`: the daemon runs `pup`, `gh`, `glab`, `bkt` or `slashdocs` outside the Run sandbox, as the operator. A read runs at once; a write waits for an Approval, and the operator may choose "Don't ask again this Session" for that CLI (ADR 0006). A run the operator started also gets the Session's output folder, told to the agent in its system prompt, and a `save_file` tool: the agent names a file or a folder of files in that folder and a destination folder, the PreToolUse hook raises an Approval in every Access mode but full, and only a yes has the daemon copy it there (`agent-output-files`). The transcript lists the folder's plain files as chips on the turn that wrote them; the viewer shows an image (SVG too, through `<img>`), PDF, video or audio as itself, text as text, HTML in a frame with no script and no network, and any other type as a download, and nothing the agent wrote is launched on this Mac. An Integration command Approval also offers "Don't ask again this Session" for its CLI: the Session's `trusted_clis` then skips the Approval for that CLI's writes until the Session is deleted. None of this
blocks a job.

**Playbooks.** Each Trigger holds one Playbook, or its built-in. A job (Verification, Fix) copies its Trigger's Playbook when it starts and runs each step as its own turn, ending
done, skipped or failed; a failed step stops the job. After the last step the console's own closing
turn writes the Report or the review, and a Fix goes on to its PR. A step tagged scratch copy may write files and
run commands, only in the job's scratch copy. A PR action Session joins its Trigger's rules, Skills and steps into its opening prompt and runs them as one turn. Chats (Session message, Reply in thread) read their
Playbook's rules at each turn. An Alert's Session uses the rules its latest job copied.

A built-in is read only and the console updates its text; the operator gets an editable Playbook through New Playbook,
Blank or Copy of a built-in, and attaches it from a Trigger's dropdown on the overview. The Playbooks page counts the
Rules and the held Skills' names and descriptions as an estimated token cost in the browser (characters divided by
four); the daemon counts nothing.

A Playbook also holds Skills. A job copies them with the Playbook, as a snapshot; a chat reads them at each turn. For each run the
daemon writes the Skills to a folder in the temp folder as a local Claude Code plugin and passes it to the SDK with the `skills` option naming only those Skills. The agent sees
their names and descriptions and loads the text through the `Skill` tool when a step needs it, which the Action Log records
as kind `skill`. The folder is removed when the run ends. A run whose folder cannot be written fails with the reason.

Skills come in three kinds: Built-in (a Skill pack's text in the console, installed by the operator), Custom (the operator's) and Project (a
`SKILL.md` folder in the Session's Repo). A Session's `$` menu lists them, read when it opens: a Repo Session shows all three, an Anonymous
Session Built-in and Custom, a dev-tools or pull request reply Session none. A message that starts with a skill (picked from the menu, or
a typed `$name` or `/name` that matches; Project first, then Custom or Built-in) runs that skill and not the Playbook, for that
message only: no Playbook rules, no Playbook Skills. A Custom skill goes to the run as the same local plugin, holding that one skill; a Built-in skill goes with the rest of its installed pack, so the skills of a pack can call one another. The other skills the agent can find stay available. A
Project skill loads from the Repo through Claude Code with the Session's settings. A skill gone at send is refused with
`skill_not_found` and starts no run. A message with no skill, and every job, runs its Playbook. The message's skill is
stored beside it, so a reload shows the chip. See `docs/diagrams/skill-message-routing.html` and
`docs/diagrams/skill-menu-sources.html`.

**Workspace pull requests.** Lists span every repository of every owner the operator can read on
each connected Git host, plus imported Repos under other owners. The daemon keeps lists in memory and
serves them stale-while-revalidate: a list older than 30 minutes (a detail older than 15 seconds) is served
at once while a background read runs, and a read that changed something sends
`pull_request.refreshed` with the changed numbers. A failed background read keeps the old list and
marks it stale, and a failed list is tried again after 5 minutes. A host that answers 429 is not read for 10 minutes, and its kept lists are served stale. Refresh drops the memory and reads again; it is the
only read besides the 30-minute one. A list row carries no description and only the status, decision and staleness of its latest Agent Review; the detail has both whole. A comment, a resolve, a delete, a review or a merge patches the kept lists and detail from the host's answer (one read of that pull request at most) instead of dropping them; a job's posts do the same after it. A comment or review pre-check, and a job's start, use the kept detail once one read of the pull request alone confirms its head commit. Bitbucket, GitHub and GitLab lists and the detail's comments, commits and files follow the host's next page. A search by words filters what is kept. A search of just a number, with or without
`#`, asks the host for that number in every known project, in any state, and keeps the answer for a minute. Mine matches
number, title and the operator's login (the email on Bitbucket); All matches number, title and author. The UI prefetches the list at load. A host that answers 404 for an owner reads as an owner with no pull requests, not as a failed read; any other failure marks the list stale. The UI groups the list by what the operator does next (changes requested, checks failing, to review, waiting on review, ready to merge, merged or closed) and a Session that worked on the branch shows as `agent`. A pull request's Commits tab lists the branch's commits from the host.

**Git calls.** The daemon's `git` processes share a pool of 8 and the host CLIs one of 6; an operator's click gets a slot before a background read. A network `git` command gives up after 8 seconds, and a job then reads the last fetched commit. Fetches of the same Repo and branch share one process while it runs, and a caller that does not need the very newest commit shares one from the last 30 seconds. A Review with agent fetches its branch, the target and the default branch before it starts; the other PR actions fetch only the pull request's branch. A Session's code update still runs beside run start-up, and the agent's first tool waits for it.

**Conflict check.** For an open pull request the daemon fetches the base and the head into the Repo's folder and runs `git merge-tree`, which touches no branch and no work tree. It runs in the background, is kept two minutes per head commit, and feeds the fifth merge check (the others: approval, checks, open threads, Agent Review). A conflict shows a box naming the files and the git commands to resolve them, marks each file `conflict`, and keeps Merge disabled. When git cannot fetch, the check reads "Conflicts not known" and does not block Merge.

**Remembered view.** The UI keeps each page's address (`app/last-address.ts`) and the picks on a page
(`lib/remember.ts`) in local storage under `ops-console:` (a few older keys, such as the theme, the token and Monitor's range, use
`ops-console-` or `ops-console.`), so page switches, reloads and reopening the console land where the operator left
off. Per Session it keeps the draft message, the attachments and the elements picked in the Browser panel; per browser, the chime switch, folded cards and the
Changes panel's width and view, and the Playbook panel's width. The page a link came from rides in the router state, so a Skills page opened from a Playbook offers the way back until the operator leaves it by another route. A stored value that no longer parses falls back to the
default.

**Session panel and subagents.** A run's subagents come from the SDK's `task_started` and notification messages; the runtime keeps them in `sessions.run_subagents` as they change and the Session API returns them as `subagents`. The Workspace shows the working ones in a row above the composer and all of them under Lineage in the Session panel (`workspace/session-panel.tsx`). Every run registers three subagents of its own (`agent/subagents.ts`: `explorer` for code searches, `test-runner` for tests, type checks and builds, `reviewer` for its own change), and the system prompt tells the agent to hand long work to them and to fan independent parts out to subagents and merge their results into one answer. They run under the run's sandbox, permission rules and hooks.

**Session browser and processes.** A `repo` or `anonymous` Session has a Browser panel and a Terminals dock (ADR 0007). A tab's page is a real Chrome page with nothing blocked; the daemon only records the outside hosts it called. The operator's address field opens any `http` or `https` URL; the agent opens and acts only on loopback pages that are not the console's own. A process starts when the operator runs a script or types in a new terminal, or approves the agent's `start_process` (an Approval in every Access mode but full, showing the command); it runs as the operator with the environment the login shell builds (`HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG` and the terminal settings go in first, never the session token). The daemon reads that environment once per folder with `$SHELL -ilc 'env -0'` in the background, starts for the folders of stored processes at daemon start, for a folder whose Terminals dock or Approval opens, and again when an rc file (`.zshenv`, `.zprofile`, `.zshrc`, `.bash_profile`, `.bashrc` and the like) or a folder's version file (`mise.toml`, `.nvmrc`, `.tool-versions`) changes; a command then runs as `$SHELL -c` with that environment, and as `$SHELL -ilc` while the first read has not finished. A terminal the operator types in is always a login shell. Stopping walks the process family: SIGHUP to the shell, SIGTERM to its children, SIGKILL after 1.5 seconds (0.5 seconds on Restart). A process whose folder's `.env` files hold the host of a PROD Connection is flagged in the dock and in the agent's Approval. A page's file picker is answered from the panel: the daemon keeps the chosen files in a temporary folder until the tab closes. A daemon exit stops every process and every Chrome; one killed with no cleanup takes its processes with it when the terminal closes, except one that ignores the hangup, which Local servers lists with a Stop (parent links only, and only for a server in the Session's folders or under its processes), and a daemon start ends a Chrome that a killed daemon left behind (a process whose command line names a profile folder under `browser/`); after a restart the processes list as stopped with Restart, and tabs are gone. Local servers come from `lsof` (a scan is reused for 1.5 seconds unless a process just started or ended, and after a start the daemon scans every 500 ms for up to 30 seconds, until a listener appears under the process), tagged with a Session when the listening process belongs to one of its processes or runs in its folders. The browser and process tools exist only in a chat the operator started; a job, a `pr_review` Session and a read-only run have none.

## `state.db` holds

Settings the operator changed (`settings`), Claude accounts, Sessions and the Connections a `devtools` Session
names, the pull requests a Session opened (`session_pull_requests`), the Action Log and Approvals, every tool call, subagent
and cost of a run (`run_steps`, `run_agents`, `run_usage`; 90 days), the checks of Connections, Connectors and MCP Servers
(`health_checks`; 90 days), MCP Servers the operator removed or disabled, Connectors (config
and last check), Connections (no secrets), Repos, Agent Reviews, what each PR action Session posted, the ids of comments the agent
posted, Services, Routes, Scans and their Route results, Alerts and their events, Reports, Reviews
and Fixes, Playbooks, the Trigger each one holds, each job's copy of its Playbook steps, Custom Skills, the installed Skill packs, the Built-in skills each Playbook holds, the skill each message was sent with, and the Session processes (name, command, folder, who started them). Pull requests stay on the Git host. Session messages stay in the Claude Code transcript, in
the config dir of the Session's Claude account.

## Agent runs

Runs a job starts (Verification, Fix, each Playbook step) go three at a time;
the rest wait first come first served and say so in their steps. A Stop on a waiting run ends it before it starts. A message
the operator sends never waits. The daemon logs a warning when its thread stalls for over a quarter of a second. On
shutdown the daemon aborts every run and waits up to 10 seconds for them to end, leaving them `working` for start-up
recovery to fail; the process ends after 20 seconds whatever is left. A run starts the MCP servers its purpose can use
(`mcp-scope.ts`): a Dev tools chat the Connections in its scope; any other chat the Connectors' servers and no
Connection's; Verification the Connections and the log source server of its Alert (Datadog's for a Datadog Alert,
CloudWatch's for a CloudWatch Alert, both when it has no Alert; a Loki Alert gets Grafana's, a New Relic Alert New Relic's, or on the key route the console's own `query_new_relic` tool, which the daemon runs with the key); Fix and the pull request jobs GitHub and Atlassian, and a Fix of a Loki or New Relic Alert its source's server,
never CloudWatch's; the pull request text none. Of CloudWatch's tools a run may call only the four log tools. A server
that starts goes through `mcp-exec`, which tells `npx` to use its cache before the registry, and the run waits up to 10
seconds for the servers it started. The code update (`refresh` on a Session kind) runs while the
run starts and holds the run's first tool until it ends. The log line for each run says where the wait before the first token went.

The operator opening a Session or starting to type may call `POST /api/sessions/:id/warm`. The daemon then starts the Claude Code
process for the next chat message through the SDK's `startup()`, built from the options that message would get now, and
keeps it for a minute (two Sessions at most). The message uses it when it would start Claude Code with the same options, and
closes it otherwise. A job's run never uses one.

Rate-limit events from a run update the account's usage only when the numbers changed, and Auto-switch looks at them at most
every 10 seconds per account. The step rows of a run (`run_steps`) are written once every quarter second and when the run
ends, and the Settings the daemon reads are kept parsed until one changes. The Running tray reads only the steps and usage of
the runs it lists and keeps the command history for two minutes.

Transcripts are read through a cache of parsed entries per Session, keyed by the file's size and modification time: a file that
only grew is parsed from where the last read stopped, and a read of an unchanged file does no parsing. A Session's transcript
is deleted with the Session, and a transcript no Session holds, with nothing written to it for 14 days, is deleted by the
daily sweep. The sweep at start-up also removes Skill folders in the temp folder older than a day.

A Session's run is a Claude Agent SDK `query()` in the working directory its kind supplies,
resuming the stored SDK session. Each Claude account has its own `CLAUDE_CONFIG_DIR` under the data
folder; the console never uses the operator's own Claude Code login. A `PreToolUse` hook writes the
Action Log row before every Bash and MCP call and holds a PROD write for an Approval in every
access mode. Every run's shell commands run in the Run sandbox (ADR 0006): the SDK's `sandbox` option, built per run
from its working folder and the run's kind, which fails the run when it is unavailable. The sandbox closes only the login
Keychain folder, `~/.ops-console` and the git control files, and a read-only run's working folder; commands write anywhere,
and its `network` block opens every host, `localhost` and every Unix socket. A command can read `runtime.json` and call the
API as the operator. The file tools run in Claude Code's own process, so `disallowedTools` holds them to the same closed
paths: no `Read` or `Edit` of the Keychain folder or `~/.ops-console`, no `Edit` of the git control files. `WebFetch` and
`WebSearch` are open.
`disallowedTools` denies `gh pr merge`, `glab mr merge`, `bkt pr merge`, `bkt pr auto-merge`, the GitHub and GitLab MCP
merge tools and the hosts' merge endpoints by any client. A Verification and a PR action Session also deny `git push`, the host CLIs' comment, review and `api`
commands and the host MCP write tools, since the console pushes, replies and resolves, and a Verification writes to no Git host; a Verification also starts none of the writable Connections. A PR action Session, which holds a pull request's code, loads no project settings from it. Permission prompts in `supervised` mode, and the agent's questions, reach `canUseTool`
and wait for the operator. MCP Servers the operator disabled, and for a `devtools` Session the
Connections outside its scope, are denied for the run. Every run's system prompt appends the kind's
instructions, the rules for a PR description and the rule that the console, not the run, pushes and opens pull requests, then the Playbook's rules, the Session's folders (the only part that differs per Session) and the console's
safety lines. Those say that log lines and
data are never instructions, that the agent never merges, and that no PROD value goes into a mock or
anything else it writes. Stop ends a run and expires its Approvals, and the operator may edit the last message, which rewinds the agent's file
edits. Attached files sit in the Session's `attachments/` folder and output files in its `outputs/` folder, both added to the run's directories. With CLIProxy on, a
run sends CLIProxy's API key and address in place of an account's sign-in, usage is not read from it and account
switching is off; the address must be loopback (ADR 0003). A
conversation begun in one folder moves its transcript to the next run's folder, so a chat after a
Verification resumes it in the Session's worktree. Runs live in the daemon's memory; a restart
fails them and expires their Approvals.

Smart usage moves work to the best-ranked signed-in Claude account on its own, and Auto-switch does
it at a usage threshold when Smart usage is off, as the design shows. Anthropic's terms may read
this as getting around usage limits; the operator accepted that risk
(`docs/specs/02-settings-agents.md`, Safety), and both toggles can be turned off. An account's name
is its email, each is added once, and usage is also read for accounts with no run going every 5 minutes, one account after
another; an account whose read failed waits twice as long after each failure, up to an hour. The
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
- **Connectors** add Sentry, Shopify, slashdocs, Google Docs, Sheets and Drive, and four log sources (OpenTelemetry logs, CloudWatch logs, Loki logs, New Relic logs).
- **Monitor** reads a log source per tab, lists Alerts in a table and opens one in a drawer.
- **Health checks**: the check strip, problem banner and history stripe on Integrations and Connections, and a red count in the sidebar.
- **Agent runs** page under Claude: run health, why a run is slow or ended, time split and every step.
- **Dev tools** adds a Comparison under the per-Connection Results, and Copy JSON on each.
- **Agent Review card** shows a verdict (approve, request changes, comment), findings rated critical to info with a
  count of each, the commits it read and compared with, and the full report, in place of the design's blockers,
  suggestions and nits.
- **Tips** on every control, status and count whose words leave its meaning open, and a "?" beside such labels.
- **Folding cards**: each card with a title folds to it, and stays folded for that kind of card.
- **Permissions** page under Connect, with Start at login.
- **Running tasks** tray in the sidebar: every agent run going with its subagents under it, and every run that ended unfinished until dismissed. Each shows how long it ran, links to its work, and pauses, stops, plays or retries from the tray.
- **Updates**: a version line and panel, an update card and an "Updated to" notice, with Check now and auto-update.
- **Claude account hub**: CLIProxy as the sign-in for agent runs, and adding an account by link.
- **Finish chime**: a soft sound when the operator's run ends, switchable per browser, under Notifications.
- **Skills page** under Claude, after Playbooks, with Discover and Yours tabs; the Playbook's **Skills** panel with a badge naming each skill's pack, or Custom, and a "Back to <Playbook>" button on the Skills page when a link from that panel opened it; the **`$` skills menu** above the Session composer and the **skill chip** with its "Playbook not used" line on a skill message.
- **Question panel**, **queued messages**, **attachments**, **output files** and the Session's **Changes** panel in Workspace.
- **Workspace lists** (`design/ops-console-sidebar.html`, shipped from `design/workspace-variants.html` Inbox): the Sessions list is flat and grouped Needs you, Running and Idle with the Repo as a chip and a filter, and one + New picks a Repo (or none) and a branch; the pull request list is grouped by the next step, with a project picker.
- **Pull request page** (shipped from `design/workspace-pr-variants.html` Cockpit, then given tabs): Overview, Files changed and Commits, and a right sidebar of folding sections with five merge checks and the conflict box. The design's blockers, suggestions and nits stay replaced by the Agent Review card.
- **Composer menus**: `$` skills, `/` commands (stop, diff, pr, skills, files) and `@` files, opened for the word before the cursor wherever it sits; a skill or file pick is a chip in the message (the box is a small contenteditable editor whose value is the plain text), and the **Repos icon** beside Attach opens other imported Repos to the Session. Attached files of any type are chips in a row above the text.
- **Session browser and Terminals** (`design/session-browser.html`): a Browser panel and a Terminals dock under the Session. Neither design file has them.
- **Spawned Sessions**: the **batch card** in the starting Session's transcript, and a "Started from" link in each Spawned Session's header.
- **Copy icon** on every code block: fenced blocks in the agent's text, commands in Approvals, raw errors and step output, replay requests and text files.
- **PR actions**: Review with agent, Check replies and Address comments each open a Session from a pull request, and the Sessions section of the pull request lists them.
- **Job timers** and Skip and Retry on each Playbook step; Expand all and Collapse all on a pull request's files.
- **Side panels fold** to a rail: Workspace and the Session's Changes.

## Diagrams

Each diagram in `docs/diagrams/` is an HTML file with an inline SVG and a PNG of the same drawing; `run-sandbox-flow` is an SVG and a PNG. Open the HTML or SVG in a browser, or read the PNG.

| Diagram | Shows |
|---|---|
| `overview` | The whole system: browser, daemon, agent, outside services |
| `layers-and-modules` | Every backend module and frontend area, with the dependencies between them |
| `product-map` | Every page and feature, their states and the jumps between pages |
| `install-update-startup` | Install, start, update and recovery |
| `homebrew-and-release` | A release tag through the release workflow to `brew install` |
| `live-data` | REST, the WebSocket, the scheduler and start-up recovery |
| `setup-and-permissions` | The Permissions page and the Setup agent |
| `connect-a-service` | Signing in to a Connector so the agent gets its tools |
| `claude-accounts` | Claude accounts: sign-in, usage, Auto-switch and Smart usage |
| `monitor-log-sources` | How a Scan reads Datadog, an OpenTelemetry folder, CloudWatch, Loki and New Relic |
| `alert-to-pull-request` | A failing route through Verify, Review and Fix to a pull request |
| `playbook-job-run` | How a Verify or Fix job runs its steps |
| `session-lifecycle` | A Session's states from message to finish |
| `agent-run-safety` | What runs where, and who approves |
| `run-sandbox-flow` | The Run sandbox: what is closed, what is open, and `run_integration` |
| `console-opens-pull-request` | The console pushes the branch and opens the pull request |
| `pull-request-review` | A Workspace pull request from list to merge: conflict check, PR action Sessions (Review with agent, Check replies, Address comments), the operator's merge |
| `session-browser-and-terminals` | The Session's Browser panel, servers and Terminals dock |
| `dev-tools-session` | Dev tools: from a Connection to Results |
| `skill-menu-sources` | What the `$` menu lists |
| `skill-message-routing` | What runs a Session message that names a skill |
