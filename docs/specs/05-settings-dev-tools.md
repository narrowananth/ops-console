# Settings: Dev tools connections

**Status:** ready
**Design:** Settings › Dev tools: the Connections list, Add with Claude (setup terminal), the type picker and the connection form (fields, Environment, Claude access, Test, Delete)

## Problem

The agent checks a failing Route against real data: a Postgres table, a Mongo collection, a Redis key. The operator has to give it those databases without pasting passwords into chat or Claude's config, and has to know that a PROD database stays read only unless they say otherwise. Today that means writing MCP Server commands by hand, once per Claude account.

## Behavior

1. Creating a Connection stores its non-secret fields, puts its secret in the Keychain adapter under the Connection id, and registers an MCP Server of the same name in every account through the launcher (`03-settings-mcp-servers`). The launch arguments come from the type and the Access Level. If registering fails, no Connection row exists and the secret is deleted.
2. Access Level `read` launches the server in read-only mode. `write` launches it with writes allowed. `none` registers no MCP Server, so the agent never sees it; the operator can still query it from Dev tools (`09-dev-tools-agent`).
3. Changing the Access Level registers the server again in every account with the new launch arguments, or removes it for `none`.
4. A Connection with env `prod` reports `is_prod: true` on every read. A new PROD Connection gets Access Level `read` unless the request sets `write`.
5. Testing an unsaved Connection launches its server with the given secret held in memory, runs one read (a ping or a list of databases), and returns status, latency and the error. Nothing is stored.
6. Checking a saved Connection does the same with the stored secret and records `status`, `latency_ms` and `last_checked_at`. A server that does not start or times out reads `fail` with the error, such as `connect ETIMEDOUT`.
7. Editing keeps blank fields as they were. A new secret replaces the Keychain entry. Any change to type, config or secret registers the server again.
8. Deleting a Connection removes its MCP Server from every account, its Keychain entry and its row.
9. A name already used by a Connection or an MCP Server is refused with `duplicate`.
10. No response, log row or event carries a secret. Reads show `secret_stored`.
11. Opening Add with Claude starts a setup terminal: `claude --agent dev-tools-setup` in node-pty, with the active account's config dir, streamed over an authenticated WebSocket.
12. A line the operator types into the setup terminal goes through the daemon first. Values after `password`, `pass`, `pwd`, `token`, `secret` or `key`, and the password in a `user:password@` URI, are kept as pending secrets in the daemon's memory. Claude sees `{{secret:<n>}}` in their place, and the echo shows them masked.
13. The setup agent works out the type, host, env and Access Level from the line, tests the connection and saves it through the console's tools. The tools take `{{secret:<n>}}` and resolve it inside the daemon. The secret never reaches Claude's transcript.
14. When the setup agent needs a secret the operator did not give, it asks through the console's tools, and the drawer shows a masked field. The value becomes a pending secret, and the agent gets only its placeholder.
15. The setup agent can also connect a Connector and authenticate an MCP Server, through the same code as those endpoints. After each save, the terminal lists what was added, linked to its tab.
16. Each test the setup agent runs writes an Action Log row of kind `query` first (`02-settings-agents`).
17. Closing the drawer or reloading the page ends the setup terminal. Pending secrets end with it.
18. Every check sends `connection.checked` with target `connection`.

## Settled

- **Connection types and form fields** (non-secret fields go in `config`; the secret goes to the Keychain):

  | Type | `config` | Secret |
  | ---- | -------- | ------ |
  | `postgres` | `host`, `port`, `database`, `user` | password |
  | `mongodb` | `database` | connection string |
  | `redis` | `host`, `port`, `db_index` | password |
  | `clickhouse` | `host`, `http_port`, `database`, `user` | password, optional |
  | `firebase` | `project_id`, `services` | service account JSON |
  | `kafka` | `bootstrap_servers`, `sasl_mechanism`, `schema_registry_url`, `kafbat_url` | SASL password, optional |

- **Read-only enforcement**: `/ship` picks, per type, an MCP Server that enforces read-only at launch (a flag or a read-only transaction). A type with no such server cannot be set to `read` until it has one. The Access Level is never only a label (GLOSSARY).
- **Launch**: every Connection server starts through `ops-console mcp-exec <name> -- <command>`, which reads the secret at launch.
- **Setup agent**: a Claude Code agent definition the console ships, with one extra MCP Server, `ops-console`. Its tools are `test_connection`, `save_connection`, `connect_connector`, `authenticate_mcp_server` and `request_secret`. The REST endpoints and these tools run the same code.
- **Terminal**: node-pty behind its own WebSocket, `/terminals/:id`. `07-workspace` reuses it for Repo shells and Claude terminals.
- **PROD writes**: on a PROD Connection with `write`, every write the agent proposes needs the operator's typed confirm, through Approvals (`02-settings-agents`).
- **Design departure**: secrets go to the Keychain, not `~/.ops-console/secrets` (ADR 0004).

## Not required

- **Secret detection**: a password in a shape the masking rule does not know reaches Claude's transcript. The terminal's intro asks the operator to give passwords when asked, not in the line.
- **Setup terminal across reloads**: a reload ends it; the operator opens it again.

## Safety

- A Connection with Access Level `none` is not registered, so no agent session can reach it.
- `read` is enforced by how the server launches, not by the prompt.
- The setup agent can save Connections, start Connector and MCP Server sign-ins, and run test reads. It cannot change an existing Connection's Access Level or delete one. Its tests are logged.
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
| `TerminalKind` | `setup` | `POST /terminals`; `07-workspace` adds kinds |

Migration of existing rows: none; the table is new.

## API

### Common

Envelopes, auth and shared error codes come from `01-base-daemon-setup`.

`Connection`: all `connections` columns, plus `is_prod` and `secret_stored`.

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /connections` | | `Connection[]` |
| `POST /connections` | `{ name, type, env, access?, config, secret? }` | 201 `Connection`; `duplicate`; `upstream_failed` if registering fails |
| `PATCH /connections/:id` | `{ name?, env?, access?, config?, secret? }` | `Connection` |
| `DELETE /connections/:id` | | 204 |
| `POST /connections/tests` | `{ type, config, secret? }` | `{ status, latency_ms, detail }`; nothing stored |
| `POST /connections/:id/checks` | | `{ status, status_detail, latency_ms, last_checked_at }` |
| `POST /terminals` | `{ kind: "setup" }` | 201 `{ id }` |
| `POST /terminals/:id/secrets` | `{ request_id, value }` | 204; answers the setup agent's `request_secret` |

### WebSocket `/terminals/:id`

Needs the session token (ADR 0003). A raw stream, outside the event envelope of `/ws`.

Client to server:

```json
{ "type": "input", "data": "string" }            // keystrokes, written as is
{ "type": "line", "text": "string" }             // a full line; secrets swapped first (Behavior 12)
{ "type": "resize", "cols": 120, "rows": 30 }
```

Server to client:

```json
{ "type": "output", "data": "string" }
{ "type": "secret_requested", "request_id": "string", "label": "string" }
{ "type": "saved", "target": "connection | connector | mcp_server", "id": "string" }
{ "type": "exit", "code": 0 }
```

`connection.checked` (target `connection`) is defined in `03-settings-mcp-servers`.

## UI

Settings › Dev tools, as designed: Add with Claude with the setup terminal and its "Try" examples, then the Connections list (name, PROD badge, type and host, "Claude: read-only"), + Add connection opening the type picker, and the form with the type's fields, Environment, Claude access (Off, Read-only, Read / write) and its hint, Test, Save and Delete.

- Empty: "No connections yet" with both ways to add one.
- Error: a failed test shows its error under the form; a failed Connection shows it in the row.
- PROD: the PROD badge on the row and the form; with Read / write, the hint says every write needs a typed confirm.

## Rejected

- **A raw terminal for setup**: keystrokes would reach Claude with the password in them. Line input lets the daemon swap secrets first.
- **The password in chat, masked only on screen**: Claude's transcript would still hold it.
- **Registering `none` Connections with Claude and filtering them per session**: one missed filter exposes the database.

## Seams

- **Backend + SQLite, over HTTP** (fakes for the `claude` CLI wrapper, the Probe, the Keychain adapter and the MCP Server processes): 1 to 10, 16.
- **Backend + SQLite, over WebSocket**: 11 to 15, 17, 18. Drives a fake setup agent through the terminal socket and asserts what Claude received, what the tools stored, and the events.

## Out of scope

- Querying Connections from the Dev tools screen: `09-dev-tools-agent`.
- Approvals and the typed confirm for PROD writes: `02-settings-agents`.
- Repo shells and Claude terminals in the Workspace: `07-workspace`.
