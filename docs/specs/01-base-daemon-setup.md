# Base layer: daemon, install and setup

**Status:** shipped
**Design:** none for the install and CLI. The app shell follows `design/ops-console.html`: top bar with the Monitor, Workspace and Dev tools views, and the Settings drawer frame with its tabs. The views and tabs stay empty until their specs.

## Problem

The operator wants the console the way T3 Code and Monocode arrive: one `curl … | sh` line, then `ops-console start`, then `ops-console open`. Nothing should need Docker, a database server or sudo. Today the repo has only docs, and those still describe Postgres, Redis and two ports.

Every later spec needs the same footing: a daemon that launchd keeps running, a local SQLite file it migrates on start, one API and WebSocket convention, a session token, settings, a scheduler, and one way to reach outside systems. That way is Claude Code: forms collect config, secrets go to the Keychain, the console registers an MCP server with Claude Code, and Claude connects to it. This spec builds that footing and nothing a screen shows.

## Behavior

Install

1. `curl -fsSL <install url> | sh` on macOS arm64 or x64 downloads `ops-console-darwin-<arch>.tar.gz` and `checksums.txt` from the GitHub Release (latest, or `OPS_CONSOLE_VERSION`), checks the SHA-256, extracts to `~/.ops-console/versions/<version>`, points `~/.ops-console/current` at it, and links `~/.local/bin/ops-console`. It runs without sudo and writes only under the home folder. When `~/.local/bin` is not on `PATH`, it prints the line to add.
2. A missing checksum, or one that does not match, stops the script with a non-zero exit. Nothing is extracted, and `current` still points at the version it pointed at before.
3. Any other OS or CPU stops the script with a non-zero exit that names the platform.
4. Installing over an existing version adds the new folder and moves `current`. The current and the previous version stay; older version folders are removed.

CLI

5. `ops-console start` writes `~/Library/LaunchAgents/dev.ops-console.plist` (`RunAtLoad`, `KeepAlive`) pointing at `current`, enables and bootstraps it in `gui/<uid>`, and returns once the daemon answers `GET /api/health`. If the daemon does not answer within 15 seconds, it prints the last log lines and exits non-zero. With the daemon already running, it says so and exits 0.
6. `ops-console stop` boots the agent out and disables it, so it stays stopped across logins until the next `start`.
7. `ops-console status` prints running or stopped, and for a running daemon its pid, version, port and health. It exits 0 when running and 3 when stopped.
8. `ops-console open` opens `http://127.0.0.1:4545/#token=<token>` with the token from the runtime file. With the daemon stopped, it says to run `ops-console start` and exits 1.
9. `ops-console logs` follows the daemon log.
10. `ops-console update` runs the installer for the latest version and restarts the daemon if it was running. Migrations apply on that start (Behavior 17).
11. `ops-console uninstall` stops the daemon, removes the plist, `~/.ops-console` and the `~/.local/bin` link, and prints the data and log folders it left in place.
12. `ops-console --version` prints the installed version.

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

27. Opening the URL from `ops-console open` stores the token in the tab's session storage and removes it from the address bar. The shell shows the top bar (Monitor, Workspace, Dev tools) and the Settings drawer with its tabs.
28. Without a token, or with a token the daemon refuses, the shell shows "Run `ops-console open` to sign in." A daemon that does not answer shows "The console daemon is not running. Run `ops-console start`."

Release and checks

29. Pushing a `v*` tag builds the arm64 and x64 tarballs on macOS runners, installs each with `install.sh` from the built files, runs `start`, `status` and `stop` against it, and only then attaches the tarballs and `checksums.txt` to the GitHub Release.
30. `pnpm check` runs lint, typecheck and tests in every package without Docker.

## Settled

- **Layout**: pnpm workspace with `frontend/`, `backend/` and `shared/`, plus `cli/` for the `ops-console` command and `install.sh` at the repo root. This spec creates the backend's `common`, `db`, `auth`, `settings`, `scheduler`, `keychain`, `claude-cli` and `mcp-client` modules; feature modules arrive with their specs.
- **Stack**: NestJS on Node 24, React 18 with Vite, Drizzle with `better-sqlite3`, Zod at every boundary, Vitest, Biome. Coding rules stay in `CODING_STANDARDS.md`.
- **Port**: `127.0.0.1:4545` serves UI and API. In development the backend runs on `4546` and Vite on `4545` proxies `/api` and `/ws` to it.
- **Install folder**: `~/.ops-console`, holding `versions/<version>` and `current`. The tarball holds a Node 24 runtime, the built backend and frontend, production `node_modules` with native modules (`better-sqlite3`, `node-pty`, `@napi-rs/keyring`) built for that platform, and `bin/ops-console`, a launcher that runs the bundled Node. The system Node is never used.
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
- **Integration layer** (ADR 0005): every outside system the console reaches is an MCP server or a CLI that Claude Code also uses. A form collects config, the secret goes to the Keychain adapter, and the console registers the server with `claude mcp add`. Fixed reads (PR lists, Scan counts, health checks) go through the MCP client or the CLI. Judgment work (Verification, Fix, Agent Review, Add with Claude, dev-tools queries) runs as an agent session; see `02-settings-agents`.
- **Docs**: `/ship` rewrites ADR 0001, adds ADR 0005, and updates `docs/architecture.md` (SQLite, no Redis or BullMQ, one port, the integration layer), `README.md` and `AGENTS.md` (install, `ops-console` commands, development without Docker, `pnpm check` with no Testcontainers note), `CODING_STANDARDS.md` (tests use a temporary SQLite file; lists return `{ data, meta }`), and the `backend/` and `frontend/` READMEs (ports, test folder). It removes `compose.yaml`.

## Not required

- **Linux and Windows**: `install.sh` refuses them (Behavior 3). A `systemd --user` unit comes later.
- **Signed or notarized builds**: files fetched with `curl` carry no quarantine flag, so Gatekeeper does not block the bundled Node.
- **Downgrade**: an older version started on a data folder a newer version migrated is not supported.
- **Backups**: none. The operator can copy `state.db` while the daemon is stopped.
- **Auto-update**: the operator runs `ops-console update`.
- **Exact job timing**: a job runs within a few seconds of its slot.

## Safety

No agent runs in this change, so the agent's reach is unchanged.

- `install.sh` needs no sudo, writes only under the home folder, and installs nothing without a matching checksum.
- The daemon binds `127.0.0.1` only, and every REST call and WebSocket needs the token issued at that start (ADR 0003).
- The token reaches the browser through the URL fragment, which is never sent to the server, and leaves the address bar on load.
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

- **Shell**: top bar with Monitor, Workspace and Dev tools, and the Settings drawer with the Agents, MCP servers, Connectors, Dev tools and Repos tabs, as in `design/ops-console.html`. Each view and tab shows an empty placeholder until its spec lands.
- **No token**: one panel with "Run `ops-console open` to sign in."
- **Daemon down**: one panel with "The console daemon is not running. Run `ops-console start`."
- Theme tokens are ported from the design now, so later screens use them (`CODING_STANDARDS.md`, Frontend).

## Rejected

- **Homebrew**: needs a tap repo and a formula to maintain, and the operator asked for a single `curl` line.
- **One compiled binary (Bun or Node SEA)**: `node-pty` and `better-sqlite3` are native modules, and `node-pty` under Bun is unproven. A tarball with a bundled Node works now.
- **The system Node**: its version would vary per machine, and native modules are built for one Node ABI.
- **Postgres and Redis**: a one-line install cannot depend on Docker or two servers. T3 Code and Monocode each keep one local SQLite file.
- **`node:sqlite`**: still experimental in Node 24. The tarball already ships native modules.
- **Two ports in production**: one origin removes CORS and makes `ops-console open` a single URL.
- **Token in the WebSocket query string**: query strings end up in logs. The subprotocol carries it instead.
- **Per-service API clients**: each outside system would need its own client, auth and config next to what Claude Code already holds. See ADR 0005.
- **Running every read through the agent**: a PR list or health check would cost tokens and seconds and could vary between runs. See ADR 0005.

## ADR

- **0001, rewritten: SQLite file for console state**: the console runs as a daemon on one Mac and keeps the state only it knows in one SQLite file in its data folder. Messages stay in the Claude Code transcript, pull requests on the Git host, and MCP servers in the `claude` CLI. Postgres moves to Considered Options: it needs Docker or a server next to a one-line install, and the shared team server it was chosen for is a separate deployment under ADR 0003. The trade-off: no offline pull request list, and no message history apart from Claude Code's.
- **0005, new: Claude Code is the integration layer**: every outside system is an MCP server or CLI registered with Claude Code. The console's forms collect config, secrets go to the Keychain, and the console registers the server with `claude mcp add`. Fixed reads call the same servers and CLIs directly, with no model turn. Judgment work runs as agent sessions. Considered: per-service API clients, which duplicate auth and config Claude Code already holds; and the agent running everything, which makes every refresh cost tokens and seconds, with results that can vary. The trade-off: the console depends on each MCP server's tools and the `claude` CLI's output format, and a server Claude Code cannot run is a server the console cannot use.

## Seams

- **Installer and CLI, shell tests** (Vitest spawning `sh install.sh` and `ops-console` with a temporary `HOME`, `OPS_CONSOLE_RELEASE_URL` pointing at a local release folder, and a fake `launchctl` on `PATH`): 1 to 12, 14.
- **Backend + SQLite, over HTTP** (Supertest, a temporary data folder per test, fakes for the Keychain adapter, the `claude` CLI and an MCP server; start-up cases close the app and open it again on the same folder): 13, 15 to 19, 21 to 24, 26.
- **Backend + SQLite, over WebSocket**: 22, 25.
- **Unit**: 20, the scheduler with a fake clock.
- **Browser** (Playwright against the built daemon): 27, 28.
- **Release job on macOS runners**: 29, with real `launchctl`. It also runs the CLI checks for 5 to 8 once per tag.
- **CI**: 30, `pnpm check` on a runner with no Docker.

## Out of scope

- Agent runtime, Sessions, session defaults, the Agents tab, Action Log and Approvals: `02-settings-agents`.
- MCP servers tab: `03-settings-mcp-servers`. Connectors: `04-settings-connectors`. Connections and the setup terminal: `05-settings-dev-tools`. Repos: `06-settings-repos`.
- Workspace, Git host adapter and pull requests: `07-workspace`. Monitor: `08-monitor-dashboard`. Dev tools view: `09-dev-tools-agent`.
- A Linux `systemd --user` unit, a custom domain for `install.sh`, a Homebrew tap, and a Tauri or Electron window around the daemon: later specs.
- `GLOSSARY.md`: this spec adds no terms.
