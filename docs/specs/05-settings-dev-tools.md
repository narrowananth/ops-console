# Settings: Dev tools connections

**Status:** shipped
**Design:** Connections: the Connections list, the type picker and the connection form (fields, Environment, Claude access, Test, Delete)

## Problem

The agent checks a failing Route against real data: a Postgres table, a Mongo collection, a Redis key. The operator has to give it those databases without pasting passwords into chat or Claude's config, and has to know that a PROD database stays read only. Today that means writing MCP Server commands by hand, once per Claude account.

## Behavior

1. Creating a Connection stores its non-secret fields, puts its secret in the Keychain adapter under the Connection id, and registers an MCP Server of the same name in every account through the launcher (`03-settings-mcp-servers`). The launch arguments come from the type and the Access Level. Create, edit and delete answer within 200 ms: the row and the Keychain change first, and the `claude mcp` calls, near a second per account, run after the response in one queue, in order. A registration that fails marks the Connection's check failed, "not added to Claude Code: …". The first check runs once the server is registered. A deleted Connection's name is free at once, before its server is gone.
2. Access Level `read` launches the server in read-only mode. `write` launches it with writes allowed. `none` registers no MCP Server, so the agent never sees it, and no Dev tools scope can name it (`09-dev-tools-agent` Behavior 2).
3. Changing the Access Level registers the server again in every account with the new launch arguments, or removes it for `none`.
4. A Connection with env `prod` reports `is_prod: true` on every read. A new Connection, PROD included, gets Access Level `read` unless the request sets another; a type with no read-only server gets `none`. A PROD Connection is never written: `write` on one, by create, by update, or by moving a `write` Connection to `prod`, is `validation_failed`.
4a. A Firebase Connection's secret is a service-account key, as its JSON or that JSON in base64, for the Connection's own `project_id`; any other secret, or a key for another project, is `validation_failed`. `services` names products from `realtime_database`, `firestore`, `auth` and `storage`, read loosely (`realtime-database`, `Firestore`).
5. Testing an unsaved Connection launches its server with the given secret held in memory, runs one read (a ping or a list of databases), and returns status, latency and the error. Nothing is stored.
6. Checking a saved Connection does the same with the stored secret and records `status`, `latency_ms` and `last_checked_at`. A server that does not start or times out reads `fail` with the error, such as `connect ETIMEDOUT`. A server that exits at start reads `fail` with the error line it printed, secrets hidden. A test or check gives up after 30 seconds.
7. Editing keeps blank fields as they were. A new secret replaces the Keychain entry. The type cannot change. Any change to name, Access Level, config or secret registers the server again; a new name removes the server under the old one. A change to env alone registers nothing.
8. Deleting a Connection removes its MCP Server from every account, its Keychain entry and its row.
9. A name already used by a Connection or an MCP Server is refused with `duplicate`.
10. No response, log row or event carries a secret. Reads show `secret_stored`.
11. The Setup agent has its own page, Setup agent, after Repos. Integrations shows "Add with Setup agent →" and
    Connections "Import with Setup agent →"; each opens it. Start setup agent starts a setup terminal: `claude --agent dev-tools-setup --model <model> --effort <effort> --mcp-config <its folder's MCP config> --strict-mcp-config --allowedTools <its setup tools> --tools "" --disable-slash-commands` in node-pty, with the active account's config dir and the model and effort from `session_defaults` (`ultrathink` runs as `max`, the CLI's top level), streamed over an authenticated WebSocket. The agent has no built-in tool, no slash command and no MCP Server but the console's own; it reaches the machine only through the console's setup tools. Those tools are allowed up front: the daemon already masks secrets and only adds, and in auto mode Claude Code would otherwise turn down a read of a credential file such as `~/.my.cnf`. It runs with `CLAUDE_CODE_NO_FLICKER=0`, Claude Code's classic renderer, so the page's terminal keeps scrollback; the full-screen renderer draws on the alternate screen, which has none.
12. A line the operator types into the setup terminal goes through the daemon first. Values after `password`, `pass`, `pwd`, `token`, `secret` or `key`, and the password in a `user:password@` URI, are kept as pending secrets in the daemon's memory. Claude sees `{{secret:<n>}}` in their place, and the echo shows them masked. Only plain requests reach Claude. The page and the daemon both refuse a line that starts with a symbol (`/login`, `!cmd`, `#`), or holds an `@path` word or a control character other than a line break, and the daemon never writes it to the pty. The page shows why. A request may be any length; the page's box grows with it up to half the window, then scrolls. In the page's box Shift+Enter adds a line and Enter sends. A request of several lines, typed or pasted, reaches Claude as one bracketed paste and then Enter, so no line submits on its own. An empty line passes, since Enter alone confirms a prompt. The socket takes no raw keystrokes.
13. The setup agent works out the type, host, env and Access Level from the line, tests the connection and saves it through the console's tools. The tools take `{{secret:<n>}}` and resolve it inside the daemon. The secret never reaches Claude's transcript.
14. When the setup agent needs a secret the operator did not give, it asks through the console's tools, and the Setup agent page shows a masked field. The value becomes a pending secret, and the agent gets only its placeholder.
15. The setup agent can also connect a Connector, add a remote MCP Server by URL and authenticate an MCP Server, through the same code as those endpoints. The daemon refuses a `stdio` MCP Server from it: that would be a command the daemon runs. The agent turns down any request that is not setting one of these up. It can also import connections from files on the machine, from URLs and from the Keychain (`11-dev-tools-import`).
16. Each test the setup agent runs writes an Action Log row of kind `query` first (`02-settings-agents`).
17. The setup terminal runs until the operator presses Close, Claude exits or the daemon stops. Switching pages or reloading leaves it running, and the Setup agent page attaches to it again with the last 64 KB it printed and any masked field still waiting. One runs at a time: Start setup agent while one runs opens that one. Pending secrets and the terminal's folder end with it. Once Claude exits, the page reads "Setup agent ended" and takes no more lines until Close.
18. Every check sends `connection.checked` with target `connection`.
19. On macOS the Setup agent tab lists the permissions macOS asks for before the agent reads the machine, one row
    each with its status. Full Disk Access lets it read folders macOS protects: on, off, or off · dev build. The
    daemon tells by opening the TCC database, which only Full Disk Access allows. The installed daemon runs as
    `Ops Console.app`, a bundle around its Node with the Ops Console name, logo and an ad-hoc signature, started by
    launchd, so System Settings lists it as Ops Console. While it is off, Start setup agent and the examples to ask
    are disabled, and the row says to drag Ops Console into the list, then run `ops-console stop` and `ops-console start`.
    "Open System Settings" opens the Full Disk Access pane and shows the app in Finder to drag into the list; the
    daemon takes the permission on its next start. A new bundled Node means a new signature, and macOS asks again.
    `pnpm dev` does the same with `Ops Console (dev).app`, a bundle around the Node that runs it, with its own id,
    started by launchd: macOS asks for the dev daemon's permissions under that name, never lends it those of the
    terminal or editor that ran `pnpm dev`, and the row says to run `pnpm dev` again. Before a new build starts,
    the console's Keychain items move to it (the program holding them reads and removes each, the new one saves it),
    so no password prompt follows; the dev MCP launcher runs on the same binary. With `OPS_CONSOLE_DEV_INLINE=1`,
    or off macOS, the daemon is no app of its own: the row reads off · dev build, offers no System Settings, and
    Start stays enabled. Keychain reads "asks each time": macOS asks before each saved
    password, and no setting grants them ahead. Passwords another app keeps in its own Keychain access group stay out of reach either way.
    The rows name no other product. The tab checks again when the page regains focus, and on "Check again". When a
    read fails with `no permission`, the agent asks the operator to turn the permission on.
20. The Connections page keeps what it shows in the address: `?connection=new` for the type picker, `new:<type>` for
    a new Connection's form, or a Connection's id for its form. Back, Forward, a reload and a copied link open the
    same view. An id with no Connection shows the list. The Connections list and the type picker read A to Z.
21. The line typed into the Setup agent and not sent stays in the page's memory, one per terminal, so switching
    pages keeps it. A reload clears it. Sending it or Close clears it.
22. Picking one of the examples to ask on the Setup agent page starts the setup terminal with that example typed in
    and not sent. On a running terminal an example replaces the line.
23. Start setup agent with no signed-in Claude account answers `invalid_state` and starts nothing; the page shows
    the message.

## Settled

- **Connection types and form fields** (non-secret fields go in `config`; the secret goes to the Keychain):

  | Type | `config` | Secret |
  | ---- | -------- | ------ |
  | `postgres` | `host`, `port`, `database`, `user` | password |
  | `mongodb` | `database`, may be blank | connection string |
  | `redis` | `host`, `port`, `db_index` | password, optional |
  | `clickhouse` | `host`, `http_port`, `database`, `user` | password, optional |
  | `firebase` | `project_id`, `services` | service-account key, JSON or base64 |
  | `kafka` | `bootstrap_servers`, `sasl_mechanism`, `schema_registry_url`, `kafbat_url` | SASL password, optional |

- **Read-only enforcement**: `/ship` picks, per type, an MCP Server that enforces read-only at launch (a flag, a config file or a read-only transaction). A type with no such server cannot be set to `read` until it has one. The Access Level is never only a label (GLOSSARY). The picks:

  | Type | MCP Server | Read-only |
  | ---- | ---------- | --------- |
  | `postgres` | `@bytebase/dbhub`, `DSN` in env | `--config` with the app's `launch/dbhub-readonly.toml`, which reads `${DSN}` and marks `execute_sql` read-only |
  | `mongodb` | `mongodb-mcp-server`, `MDB_MCP_CONNECTION_STRING` in env | `--readOnly` flag |
  | `clickhouse` | `mcp-clickhouse` | read-only unless `CLICKHOUSE_ALLOW_WRITE_ACCESS=true` |
  | `redis` | `redis-mcp-server` | none: `read` is refused, the default is `none` |
  | `firebase` | `firebase-tools mcp`, the key in a file `GOOGLE_APPLICATION_CREDENTIALS` names and the project in `.firebaserc`, both in the launcher's private folder (ADR 0004) | `--tools` loads only the read tools of the project and its `services`; `write` loads them whole with `--only core,<services>` |
  | `kafka` | none picked yet | saved with Access Level `none` only |

- **Keychain keys**: the Connection's own secret is `connection:<id>`. The env vars its server reads at launch (the Postgres DSN, for one) are derived from it and sit under `mcp:<name>` for the launcher.
- **Launch**: every Connection server starts through `ops-console mcp-exec <name> -- <command>`, which reads the secret at launch. A stored env key `@file:<name>` is a file, not an env var: `mcp-exec`, and the Connection test, write it to a private temp folder (700, the file 600), put that folder in place of `{{files}}` in the args and env values, and remove it when the server exits.
- **Setup agent**: a Claude Code agent definition the console ships, with one MCP Server, `ops-console`. Its tools are `test_connection`, `save_connection`, `connect_connector`, `authenticate_mcp_server` and `request_secret`, plus the import tools and `add_mcp_server` from `11-dev-tools-import`. The REST endpoints and these tools run the same code.
- **Terminal**: node-pty behind its own WebSocket, `/terminals/:id`. The setup terminal is its only kind. The macOS helper in `node-pty` ships without the execute bit, so the daemon sets it before the first spawn.
- **Setup terminal folder**: each terminal runs in its own folder under the data folder, which holds the agent definition and the MCP config. The console marks the folder trusted, and the account onboarded, in the account's `.claude.json`, because Claude Code's folder prompt defaults to "No, exit". A `line` writes the text, then Enter 80 ms later, because Claude Code's prompt reads both together as a paste.
- **Setup tools**: `ops-console mcp-setup` is the stdio MCP Server the agent runs. It posts each tool call to `POST /terminals/:id/tools/:tool` on the daemon, which resolves placeholders and runs the same code as the REST endpoints.
- **PROD writes**: a PROD Connection is read-only or `none` (Behavior 4). The Approval that holds a write on a PROD Connection (`02-settings-agents`), and the rule that tells a write from a read (`09-dev-tools-agent`), stay for a PROD Connection saved with `write` before this rule.
- **Design departure**: secrets go to the Keychain, not `~/.ops-console/secrets` (ADR 0004).

## Not required

- **Secret detection**: a password in a shape the masking rule does not know reaches Claude's transcript. The terminal's intro asks the operator to give passwords when asked, not in the line.
- **Setup terminal left running**: one the operator never closes runs until the daemon stops. A masked-field request waits until the operator comes back to the tab.
- **Unsent line kept private**: the unsent line (Behavior 21) is the operator's text before the daemon masks it and may hold a password, so it stays in memory and never reaches browser storage.

## Safety

- A Connection with Access Level `none` is not registered, so no agent session can reach it.
- `read` is enforced by how the server launches, not by the prompt.
- The setup agent can save Connections, add remote MCP Servers, start Connector and MCP Server sign-ins, run test reads, and read files, URLs and Keychain items with their secrets masked (`11-dev-tools-import`). It cannot change an existing Connection's Access Level or delete one. Its tests are logged.
- Secrets live in the Keychain and in daemon memory while pending, never in `state.db`, Claude's config, its transcript, logs or events.

## Database

```sql
CREATE TABLE connections (
  id               TEXT PRIMARY KEY NOT NULL,
  name             TEXT NOT NULL UNIQUE,           -- also the MCP Server name
  type             TEXT NOT NULL,                  -- ConnectionType
  env              TEXT NOT NULL,                  -- ConnectionEnv
  access           TEXT NOT NULL DEFAULT 'read',   -- AccessLevel
  config           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),  -- never a secret
  status           TEXT NOT NULL DEFAULT 'off',    -- HealthStatus
  status_detail    TEXT,
  latency_ms       INTEGER,
  last_checked_at  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

ALTER TABLE action_log ADD COLUMN connection_id TEXT REFERENCES connections (id) ON DELETE SET NULL;
```

Enums live in code only (`01-base-daemon-setup`):

| Enum | Values | Used by |
| ---- | ------ | ------- |
| `ConnectionType` | `postgres`, `mongodb`, `redis`, `clickhouse`, `firebase`, `kafka` | `connections.type` |
| `ConnectionEnv` | `local`, `dev`, `staging`, `prod` | `connections.env` |
| `AccessLevel` | `none`, `read`, `write` | `connections.access` |
| `HealthStatus` | from `03-settings-mcp-servers` | `connections.status` |
| `TerminalKind` | `setup` | `POST /terminals` |

Migration of existing rows: none; the table is new.

## API

### Common

Envelopes, auth and shared error codes come from `01-base-daemon-setup`.

`Connection`: all `connections` columns, plus `is_prod` and `secret_stored`.

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /connections` | | `Connection[]` |
| `POST /connections` | `{ name, type, env, access?, config, secret? }` | 201 `Connection`; `duplicate`; `validation_failed` for a bad config field, a missing secret the type needs, or an Access Level the type has no server for |
| `PATCH /connections/:id` | `{ name?, env?, access?, config?, secret? }` | `Connection` |
| `DELETE /connections/:id` | | 204 |
| `POST /connections/tests` | `{ type, config, secret? }` | `{ status, latency_ms, detail }`; nothing stored |
| `POST /connections/:id/checks` | | `{ status, status_detail, latency_ms, last_checked_at }` |
| `GET /terminals` | | `{ data: [{ id, kind }] }`; the running terminals |
| `POST /terminals` | `{ kind: "setup" }` | 201 `{ id }`; the running setup terminal's id when one runs; `invalid_state` with no signed-in account |
| `POST /terminals/:id/tools/:tool` | the tool's arguments | the tool's result; called only by the setup tools server (Settled) |
| `DELETE /terminals/:id` | | 204; Close: ends the terminal and its pending secrets |
| `POST /terminals/:id/secrets` | `{ request_id, value }` | 204; answers the setup agent's `request_secret` |
| `GET /terminals/disk-access` | | `{ granted, app_path }`; `app_path` null unless it runs as `Ops Console.app`, both null off macOS (Behavior 19) |
| `POST /terminals/disk-access/settings` | | 204; opens the Full Disk Access pane, and the app in Finder |

### WebSocket `/terminals/:id`

Needs the session token (ADR 0003). A raw stream, outside the event envelope of `/ws`.

Client to server:

```json
{ "type": "line", "text": "string" }             // a full line; secrets swapped first (Behavior 12)
{ "type": "resize", "cols": 120, "rows": 30 }
```

Server to client:

```json
{ "type": "output", "data": "string" }
{ "type": "secret_requested", "request_id": "string", "label": "string" }
{ "type": "saved", "target": "connection | connector | mcp_server", "id": "string" }
{ "type": "exit", "code": 0 }                     // code may be null
{ "type": "refused", "reason": "string" }        // the line broke Behavior 12 and was not written
```

`connection.checked` (target `connection`) is defined in `03-settings-mcp-servers`.

## UI

Connections, as designed, without Add with Claude: "Import with Setup agent →" in the page header, then the Connections list (type logo, name, PROD badge, type and host, status glyph, and "Claude: off", "Claude: read-only" or "Claude: read / write"), + Add connection opening the type picker (one card per type, logo and a line), and the form with the type's fields, the secret field ("Kept in the Keychain; never shown again."), Environment, Claude access (Off, Read-only, Read / write, with the levels the type has no server for disabled) and its hint, Test, Save and Delete with a confirm.

- Loading: "Loading connections…".
- Empty: "No connections yet" with both ways to add one.
- Setup agent, before it starts: "Tell Claude what to set up" with Start setup agent and examples to ask. Beside it,
  Permissions under the Ops Console logo, a Full Disk Access row (status, Open System Settings when installed and
  off, Check again) and a Keychain row, then a card of what it sets up.
- Setup agent, running: a header ("Setup agent running" or "ended") with Close, the dark terminal, the masked field
  when the agent asks for a secret, and the message box with the examples as chips and Send. Enter sends.
- Departure from the design: Add with Claude moves from Dev tools to its own page, since it also sets up MCP servers
  and Connectors.
- Error: a failed test shows its error under the form; a refused save shows for 3 seconds; a failed Connection shows
  its reason in the row in place of type and host, and in its form. A Setup agent that fails to start shows why
  under the panel.
- PROD: the PROD badge on the row and the form. With PROD picked, Read / write is greyed out and the hint says a PROD
  Connection is read-only; picking PROD while Read / write is on moves access to Read-only, or Off for a type with
  no read-only server.

## Rejected

- **A raw terminal for setup**: keystrokes would reach Claude with the password in them. Line input lets the daemon swap secrets first.
- **The password in chat, masked only on screen**: Claude's transcript would still hold it.
- **Registering `none` Connections with Claude and filtering them per session**: one missed filter exposes the database.

## Seams

- **Backend + SQLite, over HTTP** (fakes for the `claude` CLI wrapper, the Probe, the Keychain adapter and the MCP Server processes): 1 to 10, 16.
- **Backend over HTTP** (a fake Full Disk Access gate): 19's report and the System Settings call.
- **Browser** (Playwright, the Full Disk Access endpoints answered by the test): 19's step, off then on.
- **Browser** (Playwright, the terminal endpoints answered by the test): 17's page switch and Close, 21.
- **Backend + SQLite, over WebSocket**: 11 to 15, 17, 18, 23. Drives a fake setup agent through the terminal socket and asserts what Claude received, what the tools stored, and the events.
- **Not pinned by a test yet**: 20, 22.

## Out of scope

- Querying Connections from the Dev tools screen: `09-dev-tools-agent`.
- Approvals and the typed confirm for PROD writes: `02-settings-agents`.
- Repo shells and Claude terminals in the Workspace: a later spec; `07-workspace` leaves them out.
