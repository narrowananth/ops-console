# Base layer: daemon, install and setup

**Status:** shipped
**Design:** none for the install and CLI. The app shell follows `design/ops-console-sidebar.html`: a left sidebar with every page.

## Problem

The operator wants the console the way T3 Code and Monocode arrive: one `curl … | sh` line, then `ops-console start`, then `ops-console open`. Nothing should need a database server or sudo.

Every later spec needs the same footing: a daemon that launchd keeps running, a local SQLite file it migrates on start, one API and WebSocket convention, a session token, settings, a scheduler, and one way to reach outside systems. That way is Claude Code: forms collect config, secrets go to the Keychain, the console registers an MCP server with Claude Code, and Claude connects to it. This spec builds that footing and the app shell around the pages, and nothing a page shows.

## Behavior

Install

1. `curl -fsSL <install url> | sh` on macOS arm64 or x64 downloads `ops-console-darwin-<arch>.tar.gz` and `checksums.txt` from the GitHub Release (latest, or `OPS_CONSOLE_VERSION`), checks the SHA-256, extracts to `~/.ops-console/versions/<version>`, points `~/.ops-console/current` at it, and links `~/.local/bin/ops-console`. It runs without sudo and writes only under the home folder. When `~/.local/bin` is not on `PATH`, it prints the line to add.
2. A missing checksum, or one that does not match, stops the script with a non-zero exit. Nothing is extracted, and `current` still points at the version it pointed at before.
3. Any other OS or CPU stops the script with a non-zero exit that names the platform.
4. Installing over an existing version adds the new folder and moves `current`. The current and the previous version stay; older version folders are removed.

CLI

5. `ops-console start` writes `~/Library/LaunchAgents/dev.ops-console.plist` (`RunAtLoad`, `KeepAlive`) pointing at `current`, enables and bootstraps it in `gui/<uid>`, and returns once the daemon answers `GET /api/health`. If the daemon does not answer within 15 seconds, it boots the agent out again, prints the last 20 log lines and exits non-zero. With the daemon already running, it says so and exits 0.
6. `ops-console stop` boots the agent out and disables it, so it stays stopped across logins until the next `start`.
7. `ops-console status` prints running or stopped, and for a running daemon its pid, version, port and health. It exits 0 when running and 3 when stopped.
8. `ops-console open` opens `http://127.0.0.1:4545/#token=<token>` with the token from the runtime file, in the default browser, or with `ops-console open <app>` in that browser app, so a second browser signs in too. It never prints the token. Every signed-in browser works on the one daemon at once. With the daemon stopped, it says to run `ops-console start` and exits 1.
9. `ops-console logs` follows the daemon log.
10. `ops-console update` runs the installer for the latest version and restarts the daemon if it was running. Migrations apply on that start (Behavior 17). The console also updates itself; see Updates below.
11. `ops-console uninstall` stops the daemon, removes the plist, `~/.ops-console` and the `~/.local/bin` link, and prints the data and log folders it left in place.
12. `ops-console --version` prints the installed version.

Updates

- The sidebar footer shows the installed version under the theme and collapse buttons. Clicking it opens the version panel. The panel shows the installed and latest versions, when the console last checked (with Check now), the new version's release notes, the Update automatically switch and Update.
- The daemon reads the newest GitHub release (`GET /updates`) 10 seconds after it starts and every minute after that. Each check asks `github.com/<repo>/releases/latest` for its redirect to the newest tag, which uses no API quota; GitHub's API is asked only for a tag not seen yet, for its date and notes, and without them the version alone is enough to update. It reads nothing in a development build. If GitHub can't be reached, the panel says so and keeps the last answer.
- Update automatically is on by default (setting `updates.auto_update`). With it on, a newer release installs by itself. With it off, an Update available card above the account card offers Update and What's new. In the collapsed sidebar, the version button is the bare version number, with a dot for a newer one.
- An update waits until no agent run is going, because a restart fails each run going. Auto-update always waits. A manual Update with runs going asks first: Update anyway installs now, and Wait until idle installs once Running reads 0.
- Installing runs the installed version's `install.sh` for the new version. The daemon then stops, and launchd starts it again from `current`. The page shows that the console is restarting, and loads the new version's UI once it answers. A failed install leaves the old version running and says why. Auto-update does not try a failed install again; Try again does.
- The first start on a new version shows an Updated to vX notification bottom right. It says whether auto-update put it there, links to the release notes, and stays closed once closed.

Daemon

13. The daemon listens on `127.0.0.1:4545` only. `/api/*` is REST (other specs write paths without the `/api` prefix), `/ws` is the WebSocket, and every other path serves the built UI, with unknown client routes falling back to `index.html`.
14. If the port is taken, the daemon exits with a log line naming the port, and `start` reports it (Behavior 5).
15. On start the daemon writes the runtime file in the data folder with `pid`, `port`, `version`, `started_at` and a new session token, with mode `0600` so only the operator can read it. A clean stop removes it.
16. A daemon started on a data folder whose lock file another running daemon holds exits before it opens `state.db`, with a log line naming the folder and the other daemon's pid. A lock file left by a daemon that no longer runs is taken over. A clean stop removes the lock file.
17. On an empty data folder the daemon creates `state.db` and applies every migration. A later start applies only migrations not yet applied, and existing rows stay.
18. A migration that fails rolls back, the daemon exits, and the log names the migration. `state.db` is as it was before that start.
19. After migrations and before the port opens, the daemon runs every registered start-up recovery function in registration order. No request is served until they finish.
20. A scheduled job runs at each slot while the daemon runs. A job whose slot passed while the daemon was stopped runs once at start, however many slots were missed. A job that throws is logged and runs again at its next slot.
21. `GET /api/settings` returns every registered key with its stored value, or its default when none is stored. `PATCH /api/settings` validates each key with that key's schema. An unknown key or a bad value returns `validation_failed` naming the key, and nothing is written.
22. A REST request without the session token returns `unauthorized`. A WebSocket connection without it is refused.
23. List endpoints page with `limit` and `cursor`. `meta.next_cursor` is `null` on the last page.
24. Errors use the `{ error: { code, message } }` envelope. A bad body, query or param returns `validation_failed` with the field names in `message`. An unknown `/api` path returns `not_found`.
25. A WebSocket event goes out after its transaction commits. A change that rolls back sends no event.
26. The daemon log holds start, stop, migration and error lines. The session token and any value read from the Keychain adapter never appear in it.

App shell

27. Opening the URL from `ops-console open` stores the token in the browser's local storage and removes it from the address bar, so closing the tab and opening the console again stays signed in while the daemon runs. A token the daemon refuses, such as after a restart issued a new one, is cleared (`persist-selections-and-runs`). The shell shows the left sidebar with every page.
28. Without a token, or with a token the daemon refuses, the shell shows "Run `ops-console open` to sign in." A daemon that does not answer shows "The console daemon is not running. Run `ops-console start`."
28a. Each sidebar link opens its page at the address it had when the operator last left it, picks in the address included. Opening `/`, or any path that is no page, goes to the last page visited, or Monitor the first time. The browser keeps both in local storage.
28b. A sidebar item shows what waits there: Monitor the count of Alerts it lists that are not resolved or dismissed, Integrations the count of Connectors and of MCP Servers with no Connector that read `auth` or `fail`, Connections and Repos how many there are. A count of 0 shows no badge.
28c. The sidebar foot shows the active Claude account, or the first signed-in one, with its 5-hour and weekly usage, and links to Agents & accounts. With no signed-in account it shows nothing.
28d. The theme switch moves between light and dark, and Collapse leaves icons only, each naming its page on hover. The browser keeps both. The first theme follows the system's.
28e. A page scrolls inside its own body, never past the app: an absolutely placed element inside a scroll box, such as a label only screen readers read, stays within that box.
28f. Running, above the account in the sidebar foot, counts the Sessions of every kind whose run goes, `waiting_input` and `waiting_approval` included, and is tinted while any waits on the operator. It opens a list, most recently active first: each run's Session title (a `pr_review` run reads "Pull request #N"), its Repo ("No Repo", "Dev tools") and branch, its state or "needs you", and an Alert link for a Monitor Session. A run opens where its work shows: the Session in Workspace, the pull request for a `pr_review`, Dev tools for a `devtools`. Moving to another page, Escape or a click outside closes the list. With none running it reads "No agent running".
28g. Each control, status, badge and count whose meaning its words leave open explains itself in a tip: what it means, what pressing it makes the agent do, or why it is off and what turns it on. A label with no control beside it gets a "?" that shows its tip. The tip shows after a short rest of the pointer or at once on keyboard focus, sits inside the window, and closes on leaving, a click, a scroll or Escape. Screen readers read it as the element's description.

Release and checks

29. Pushing a `v*` tag builds the arm64 and x64 tarballs on macOS runners, installs each with `install.sh` from the built files, runs `start`, `status` and `stop` against it, and only then attaches the tarballs and `checksums.txt` to the GitHub Release.
30. `pnpm check` runs lint, typecheck and tests in every package.

## Settled

- **Layout**: pnpm workspace with `frontend/`, `backend/` and `shared/`, plus `cli/` for the `ops-console` command and `install.sh` at the repo root. This spec creates the backend's `common`, `db`, `auth`, `settings`, `scheduler`, `keychain`, `claude-cli` and `mcp-client` modules; feature modules arrive with their specs.
- **Stack**: NestJS on Node 24, React 18 with Vite, Drizzle with `better-sqlite3`, Zod at every boundary, Vitest, Biome. Coding rules stay in `CODING_STANDARDS.md`.
- **Port**: `127.0.0.1:4545` serves UI and API. In development the backend runs on `4546` and Vite on `4545` proxies `/api` and `/ws` to it.
- **Install folder**: `~/.ops-console`, holding `versions/<version>` and `current`. The tarball holds a Node 24 runtime, the built backend and frontend, production `node_modules` with native modules (`better-sqlite3`, `node-pty`, `@napi-rs/keyring`) built for that platform, `bin/ops-console`, a launcher that runs the bundled Node, and `Ops Console.app`, that Node in an app bundle with the Ops Console name and logo, which launchd runs as the daemon (`05-settings-dev-tools` Behavior 19). `node/bin/node` links to the bundle's binary. The system Node is never used.
- **Install URL**: `install.sh` is served from `raw.githubusercontent.com` until there is a domain. `OPS_CONSOLE_RELEASE_URL` points it at another release folder, which the release job and tests use.
- **launchd**: label `dev.ops-console`, stdout and stderr to the daemon log.
- **Data folder**: `~/Library/Application Support/ops-console`, or `OPS_CONSOLE_DATA_DIR` when set. It holds `state.db`, the runtime file and the lock file. Tests point it at a temporary folder. Updating and uninstalling leave it in place.
- **Runtime file**: `runtime.json` in the data folder, written once the port is open, mode `0600`. It holds the session token, so no other local user may read it.
- **Data folder lock**: `daemon.lock` in the data folder holds the daemon's pid. The daemon creates it with an exclusive create before opening `state.db`. When it exists and its pid still runs, the daemon refuses to start; when its pid no longer runs, the daemon replaces it. Two daemons on one `state.db` would race on migrations and overwrite each other's runtime file and token.
- **Daemon log**: `~/Library/Logs/ops-console/daemon.log`.
- **Store**: one SQLite file opened only by the daemon, with `journal_mode = WAL`, `foreign_keys = ON` and `busy_timeout = 5000`. Every table is `STRICT`. Ids are uuid text set by the daemon. Times are ISO 8601 UTC text with milliseconds and a `Z`. Booleans are `INTEGER` 0 or 1. JSON is `TEXT` with a `json_valid` check.
- **Enums**: in code only, as TypeScript string enums in `shared/`, used by the Drizzle column type, the Zod schemas and the API types. Columns are plain `TEXT` with no `CHECK` list. Each spec lists its enums in a table under its Database section. Only `NOT NULL`, keys, `UNIQUE`, partial unique indexes, `json_valid`, booleans and checks that tie two columns together stay in SQL.
- **Migrations**: Drizzle Kit generates them; the daemon applies them on start, each in a transaction. A spec adds columns to an earlier spec's table with `ALTER TABLE … ADD COLUMN`.
- **Transactions**: a state change and every row it writes commit together, and its WebSocket event goes out after the commit.
- **Start-up recovery**: a module registers a function; each spec says what it closes on start (rows left `running` and the like). This spec registers none.
- **Scheduler**: in-process timers, no queue. A job registers a name, its slots and a handler. The last run time of each job is kept in memory and rebuilt from the owning spec's rows on start.
- **Settings**: a key, a Zod schema and a default, registered by the spec that owns the key. A row exists only once the operator changes a value.
- **Token**: 32 random bytes, base64url, new on every start (ADR 0003). REST sends `Authorization: Bearer <token>`. The WebSocket sends it as the second subprotocol, `["ops-console", "<token>"]`, so it stays out of URLs.
- **Keychain adapter** (ADR 0004): `set`, `get` and `delete` by key in the login Keychain under service `ops-console`, through `@napi-rs/keyring`. Tests use a fake.
- **Claude CLI wrapper**: runs `claude` with an argument array, never a shell string, and parses each output with Zod. It covers `claude mcp add`, `remove`, `list` and `get`. Tests use a fake.
- **MCP client**: connects to a server registered with Claude Code, using the config `claude mcp get` returns, to call a tool directly for a fixed read with no model turn. Tests use a fake MCP server.
- **Integration layer** (ADR 0005): every outside system the console reaches is an MCP server or a CLI that Claude Code also uses. A form collects config, the secret goes to the Keychain adapter, and the console registers the server with `claude mcp add`. Fixed reads (PR lists, Scan counts, health checks) go through the MCP client or the CLI. Judgment work (Verification, Fix, Agent Review, the Setup agent, dev-tools queries) runs as an agent session; see `02-settings-agents`.
- **Docs**: `/ship` rewrites ADR 0001, adds ADR 0005, and updates `docs/architecture.md` (SQLite, one port, the integration layer), `README.md` and `AGENTS.md` (install, `ops-console` commands, development, `pnpm check`), `CODING_STANDARDS.md` (tests use a temporary SQLite file; lists return `{ data, meta }`), and the `backend/` and `frontend/` READMEs (ports, test folder).

## Not required

- **Linux and Windows**: `install.sh` refuses them (Behavior 3). A `systemd --user` unit comes later.
- **Signed or notarized builds**: files fetched with `curl` carry no quarantine flag, so Gatekeeper does not block the bundled Node.
- **Downgrade**: an older version started on a data folder a newer version migrated is not supported.
- **Backups**: none. The operator can copy `state.db` while the daemon is stopped.
- **Exact job timing**: a job runs within a few seconds of its slot.

## Safety

No agent runs in this change, so the agent's reach is unchanged.

- `install.sh` needs no sudo, writes only under the home folder, and installs nothing without a matching checksum.
- The daemon binds `127.0.0.1` only, and every REST call and WebSocket needs the token issued at that start (ADR 0003).
- The token reaches the browser through the URL fragment, which is never sent to the server, and leaves the address bar on load. The browser keeps it in local storage until the daemon refuses it.
- The daemon log never holds the token or a Keychain value.
- The runtime file, which holds the token, is readable only by the operator (mode `0600`).

## Database

```sql
CREATE TABLE settings (
  key         TEXT PRIMARY KEY NOT NULL,         -- registered by the spec that owns it
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
```

Drizzle keeps its own migrations table. This spec adds no enum columns.

Migration of existing rows: none. No data folder exists yet; the first start creates `state.db` and this table.

## API

### Common

REST lives under `/api`. Every route needs the token (Settled).

Success bodies are `{ data }`, `{ data, meta }` for lists, or 204 with no body. Lists take `limit` (default 50, max 200) and `cursor`.

```json
{
  "data": [ "..." ],
  "meta": { "next_cursor": "string | null" }
}
```

Errors:

```json
{ "error": { "code": "string", "message": "string" } }
```

`message` is safe to show and never holds a secret. The client branches on `code`.

| Status | Error code | When |
| ------ | ---------- | ---- |
| 400 | `validation_failed` | Body, query or params fail the schema. `message` lists the field names |
| 401 | `unauthorized` | Missing or wrong token |
| 404 | `not_found` | No row with that id, or no such `/api` path |
| 409 | `invalid_state` | The row's status or state does not allow this action |
| 409 | `duplicate` | A unique value already exists |
| 429 | `rate_limited` | An outside system rate limited the call; `message` names which |
| 502 | `upstream_failed` | An outside system or the `claude` CLI failed |
| 500 | `internal` | The daemon hit an error it did not expect; the daemon log has it |

Later specs add their own codes to this table in their own Common section.

### `GET /api/health`

```json
{ "data": { "status": "ok", "version": "string", "started_at": "string" } }
```

### `GET /api/settings`

Returns `{ "data": { "<key>": <value> } }` for every registered key, stored value or default.

### `PATCH /api/settings`

Body `{ "<key>": <value> }`, one or more keys. Returns the same shape as `GET` after the write. Errors: `validation_failed` naming the first bad or unknown key.

### WebSocket `/ws`

The server sends; the client sends nothing. Each event is sent once, after its transaction commits. After a reload the client refetches over REST and then applies events.

Envelope for every event:

```json
{ "event": "string", "at": "string", "data": {} }
```

### WebSocket `settings.updated`

Server to client, after a `PATCH /api/settings` commits.

```json
{ "keys": ["string"] }
```

## UI

- **Shell**: a left sidebar, as in `design/ops-console-sidebar.html`. Operate: Monitor, Workspace, Dev tools. Connect: Integrations, Connections, Repos, Setup agent. Claude: Agents & accounts. Each item is a route (`/monitor`, `/workspace`, `/devtools`, `/integrations`, `/connections`, `/repos`, `/setup`, `/agents`) with a page header: title, one line and the page's main actions (Integrations "Add with Setup agent →", Connections "Import with Setup agent →"). The active item is bold with its icon in the accent colour. Badges follow Behavior 28b. The foot holds the active Claude account's 5-hour and weekly usage, then Dark or Light and Collapse; collapsed, the foot keeps only the two buttons. Buttons, fields, cards, badges and switches are rounded.
- **No token**: one panel with "Run `ops-console open` to sign in."
- **Daemon down**: one panel with "The console daemon is not running. Run `ops-console start`."
- Theme tokens are ported from the design now, so later screens use them (`CODING_STANDARDS.md`, Frontend).

## Rejected

- **Homebrew**: needs a tap repo and a formula to maintain, and the operator asked for a single `curl` line.
- **The system Node**: its version would vary per machine, and native modules are built for one Node ABI.
- **`node:sqlite`**: still experimental in Node 24. The tarball already ships native modules.
- **Two ports in production**: one origin removes CORS and makes `ops-console open` a single URL.
- **Token in the WebSocket query string**: query strings end up in logs. The subprotocol carries it instead.
- **Per-service API clients**: each outside system would need its own client, auth and config next to what Claude Code already holds. See ADR 0005.
- **Running every read through the agent**: a PR list or health check would cost tokens and seconds and could vary between runs. See ADR 0005.

## ADR

- **0001, rewritten: SQLite file for console state**: the console runs as a daemon on one Mac and keeps the state only it knows in one SQLite file in its data folder. Messages stay in the Claude Code transcript, pull requests on the Git host, and MCP servers in the `claude` CLI. The trade-off: no offline pull request list, and no message history apart from Claude Code's.
- **0005, new: Claude Code is the integration layer**: every outside system is an MCP server or CLI registered with Claude Code. Connecting one hands off to the provider's own browser sign-in, with nothing typed before Connect; a secret the console holds goes to the Keychain, and the console registers the server with `claude mcp add`. Fixed reads call the same servers and CLIs directly, with no model turn. Judgment work runs as agent sessions. Considered: per-service API clients, which duplicate auth and config Claude Code already holds; and the agent running everything, which makes every refresh cost tokens and seconds, with results that can vary. The trade-off: the console depends on each MCP server's tools and the `claude` CLI's output format, and a server Claude Code cannot run is a server the console cannot use.

## Seams

- **Installer and CLI, shell tests** (Vitest spawning `sh install.sh` and `ops-console` with a temporary `HOME`, `OPS_CONSOLE_RELEASE_URL` pointing at a local release folder, and a fake `launchctl` on `PATH`): 1 to 12, 14.
- **Backend + SQLite, over HTTP** (Supertest, a temporary data folder per test, fakes for the Keychain adapter, the `claude` CLI and an MCP server; start-up cases close the app and open it again on the same folder): 13, 15 to 19, 21 to 24, 26.
- **Backend + SQLite, over WebSocket**: 22, 25.
- **Unit**: 20, the scheduler with a fake clock.
- **Browser** (Playwright against the built daemon): 27, 28, 28a, and Collapse in 28d. 28b, 28c, 28e and the theme have no test.
- **Release job on macOS runners**: 29, with real `launchctl`. It also runs the CLI checks for 5 to 8 once per tag.
- **CI**: 30, `pnpm check` on a runner.

## Out of scope

- Agent runtime, Sessions, session defaults, Agents & accounts, Action Log and Approvals: `02-settings-agents`.
- Integrations: MCP Servers in `03-settings-mcp-servers`, Connectors in `04-settings-connectors`. Connections and the Setup agent: `05-settings-dev-tools`. Repos: `06-settings-repos`.
- Workspace, Git host adapter and pull requests: `07-workspace`. Monitor: `08-monitor-dashboard`. Dev tools: `09-dev-tools-agent`.
- A Linux `systemd --user` unit, a custom domain for `install.sh`, a Homebrew tap, and a Tauri or Electron window around the daemon: later specs.
- `GLOSSARY.md`: this spec adds no terms.
