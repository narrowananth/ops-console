# Dev tools agent

**Status:** shipped
**Design:** Dev tools in `design/ops-console.html`: the `ops-agent · dev tools` terminal panel with its Connection scope picker

## Problem

The operator wants to ask questions of their databases and queues in plain words ("find shop glowbar", "show 5 pending reservations", "why is this query slow on prod") without opening a client per Connection. The agent can query every Connection through its MCP server, but the operator must control which Connections it touches, see each query before its result, and keep PROD read-only unless they approve a write.

## Behavior

1. Creating a `devtools` Session stores its Connection scope. An empty scope means every Connection whose Access Level is not `none`.
2. A scope that names a Connection with Access Level `none` is refused with `connection_no_access`.
3. Each agent run gets the MCP servers of the Connections in scope, launched as their Access Level says (`05-settings-dev-tools`). A Connection outside the scope is not reachable in that run.
4. Changing the scope, or a Connection's Access Level, applies to the next run. A Connection set to `none` leaves every scope.
5. Before each query the agent runs, an Action Log row of kind `query` exists with the Connection and `is_prod` (`02-settings-agents`).
6. Each query appears in the Session as a `step` part naming the Connection and its Access Level, for example `mongo-prod (read-only)`, before its result.
7. A write on a PROD Connection creates an Approval and waits, in every access mode. Denied: the Action Log row is `denied` and the agent is told. A write on a Connection with Access Level `read` is refused by the server and logged `failed`.
8. A Connection in scope whose MCP server is down or needs a login is reported in a `step` part and skipped. The run goes on with the others.
9. Deleting a Connection removes it from every scope. The Session stays.
10. Two `devtools` Sessions run side by side.

## Settled

- **Session kind**: `devtools`, with no Repo (`07-workspace` enforces that in code).
- **Scope**: stored in `session_connections`. Empty means every Connection with access.
- **Agent work** (ADR 0005): every dev-tools question is an agent run. The console runs no query itself.
- **Read by default**: a new Connection's Access Level is `read`; `write` takes an explicit change (`05-settings-dev-tools`).
- **PROD-write rule**: this spec supplies it (`05-settings-dev-tools` left it). A tool call on a PROD Connection with Access Level `write` that the classifier does not know to be a read waits for an Approval. SQL (`execute_sql`, `run_query`) is a read only when every statement starts with `select`, `show`, `explain`, `describe`, `values`, `table` or `with` and holds no write keyword; Mongo reads by tool name, with `aggregate` a write when it holds `$out` or `$merge`; Redis reads by tool name; any tool not known to read counts as a write. A `read` Connection asks nothing: its server is launched read-only and refuses the write.
- **`is_prod` on a query**: true for every call on a PROD Connection, read or write. The Action Log row also stores the Connection's id.
- **Step label**: `<name> (read-only)` for Access Level `read`, `<name> (read-write)` for `write`, on the live message and on the transcript read back.
- **Unreachable server**: a Connection in scope whose server reports `failed` or `needs-auth` when the run starts gets a `step` part, `<name> (read-only): is down, skipped` or `needs a login, skipped`. The part lives on the streamed message; the finished transcript is Claude Code's own and does not keep it.
- **Working folder**: a `devtools` run has no Repo and runs in `devtools/` under the data folder.
- **Leaving a scope**: setting a Connection to `none` removes its rows from every scope. A Session scoped to that one Connection then has an empty scope, which means every Connection with access.
- **Create dispatch**: `POST /sessions` picks the handler by `kind`; a body with no `kind` is a `repo` Session. A kind with no creator (`pr_review`) or an unknown kind answers `validation_failed`.
- **Panel**: the Dev tools screen shows one Session as a terminal-styled transcript with a composer and a scope picker. Its messages come from the transcript (`02-settings-agents`).

## Not required

- **Cross-Connection joins**: the agent can combine results in its answer; the console does not join data.
- **Result export**: Copy JSON is UI-only; no download endpoint.

## Safety

- The agent reaches only the Connections in scope with Access Level `read` or `write`.
- `read` launches the MCP server read-only. A PROD write needs an Approval in every access mode, `full` included.
- Every query writes an Action Log row first, with the command redacted.

## Database

```sql
CREATE TABLE session_connections (
  session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  connection_id  TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, connection_id)
) STRICT;
```

No enums of its own.

Migration of existing rows: none.

## API

### Common

Errors added here:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `connection_no_access` | The scope names a Connection with Access Level `none` |

### `POST /sessions` (extends `02-settings-agents`)

Adds `connection_ids: ["uuid"]` for kind `devtools`; empty or missing means every Connection with access. Errors: `connection_no_access`.

### `PATCH /sessions/:id` (extends `02-settings-agents`)

Adds `connection_ids` for a `devtools` Session. Applies to the next run. Errors: `connection_no_access`.

### `Session` (extends `02-settings-agents`)

Adds `connection_ids` for `devtools` Sessions.

Messages, `session.output`, `session.finished`, `approval.requested` and `action.logged` come from `02-settings-agents` unchanged.

## UI

- Dev tools screen: "Open terminal" starts or reopens the dev-tools Session. Header shows `scope:` with the chosen Connections or "all".
- Scope picker: Connections with their env and Access Level; `none` ones are shown disabled; PROD ones tagged.
- Empty: no Connections yet, with a link to Settings › Dev tools.
- An Approval for a PROD write shows inline with approve and deny.

## Rejected

- **Console-run queries with the agent only writing them**: a second query path per Connection type, which the MCP servers already provide.
- **Scope fixed at creation**: the design lets the operator change the scope chips between questions.

## Glossary

None added or changed.

## Seams

- **Backend + SQLite, over HTTP** (Supertest, temporary data directory, fakes for the agent runtime and MCP servers): 1 to 4, 9, 10.
- **Backend + SQLite, over WebSocket**: 5 to 8. Asserts `action.logged`, `approval.requested` and the `step` parts in `session.output`.

## Out of scope

- Connections, Access Levels, MCP launch arguments and the setup terminal: `05-settings-dev-tools`.
- Agent runtime, Approvals and the Action Log: `02-settings-agents`.
