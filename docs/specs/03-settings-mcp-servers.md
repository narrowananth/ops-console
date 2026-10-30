# Settings: MCP servers

**Status:** shipped
**Design:** Settings › MCP servers, its detail drawer (Details, Tools, Reconnect, Disconnect, Remove) and the add and edit form

## Problem

The agent works through MCP Servers registered in Claude Code. The operator has no way to see which ones are connected, which need auth, and which failed to start, short of running `claude mcp list` in each Claude account. Adding a server by hand puts its API keys in Claude Code's config file in plain text, and a server added in one account is missing in the others.

This spec gives the operator one list across every account, and add, edit, authenticate, reconnect, disable and remove from the console. The console registers each server with the `claude` CLI so the agent connects on its own (ADR 0005, `01-base-daemon-setup`).

## Behavior

1. Listing MCP Servers reads every Claude account's config (user and local scope), merged by name. Project-scoped servers from each Repo's `.mcp.json` join the list once `06-settings-repos` lands. Each entry shows transport, command or URL, scope, status, tool count, and the Connector using it (`used_by`) when one matches.
2. Servers that back a Connection are left out. `meta.connection_server_count` says how many there are, and the tab links to Settings › Dev tools.
3. Status comes from a Probe per account. A server's status is the worst across accounts (`fail`, then `auth`, then `ok`); `status_detail` names the account and the error. A disabled server reads `off`. Probe results are kept in memory for 60 seconds.
4. Adding a server takes name, transport, command or URL, scope, and env vars (stdio) or headers (http, sse). Env vars go to the Keychain adapter under `mcp:<name>`. A stdio server with env vars is registered as `ops-console mcp-exec <name> -- <command>`; at launch that wrapper reads the env vars from the Keychain and starts the command with them. A stdio server with none is registered as its own command. The console runs `claude mcp add` in every account's config dir (user scope, or local scope in the folder `mcp-local` of the data folder) or writes the Repo's `.mcp.json` once (project scope, once `06-settings-repos` lands), then checks the server.
5. If registering fails in any account, the accounts already done are rolled back, the Keychain entry is deleted, and the response is `upstream_failed`.
6. Headers for http and sse servers are passed to `claude mcp add --header`. Claude Code sends them itself, so it keeps them in its own config file in plain text. The form says so and suggests OAuth instead: leave headers empty and Authenticate.
7. A name already used by a server, a removed server or a Connection is refused with `duplicate`.
8. Editing changes transport, command or URL, scope, env vars or headers; blank fields keep their value; the name cannot change. A change registers the server again in every account and checks it.
9. Authenticate runs `claude mcp login <name>` for each account whose Probe reads `auth`, which opens the sign-in in the browser. On success the status is `ok`. A cancelled or failed sign-in leaves it `auth`.
10. Reconnect starts a new Probe and reloads the tools. A server registered in some accounts but not others is first registered in the missing ones, copied from an account that has it.
11. Disable keeps the server out of every session the console starts (agent runs and terminals). Its config and login stay, and its status reads `off`. Enable undoes it.
12. Remove runs `claude mcp logout` and `claude mcp remove -s <scope>` in every account, deletes the `mcp:<name>` Keychain entry, and stores name, scope, transport and target in `removed_mcp_servers`. The list still shows it, with `registered: false` and status `auth`.
13. Authenticate on a removed server registers it again from that row, signs in, and deletes the row. A stdio server that needed env vars opens the edit form first, because its env vars were cleared.
14. A server added or removed outside the console (in a terminal) shows up or drops out on the next list, unless it is in `removed_mcp_servers`.
15. No response, event or log carries an env var value or a header value. Reads show `env_keys` (names only) and `has_headers`.
16. Every check, sign-in and Reconnect sends `connection.checked` with target `mcp_server`.

## Settled

- **Probe**: an Agent SDK session started with one account's config dir. It asks Claude Code for each MCP Server's state, error and tools once none is pending, and stops before any model turn. No tokens are spent.
- **Listing**: the servers an account registers are read from its `.claude.json`; `claude mcp list` starts every server, so it is never used. Signed-out accounts get registrations but no Probe.
- **Launcher**: `ops-console mcp-exec <name> -- <command>` is the stdio launch command for every server whose secrets the console holds, Connections included (`05-settings-dev-tools`). It reads the Keychain at launch, so secrets reach the server process and nothing else. Its path comes from `OPS_CONSOLE_LAUNCHER`, and defaults to the installed `~/.ops-console/current/bin/ops-console`.
- **Env var storage**: all of a server's env vars are one JSON object under the Keychain key `mcp:<name>`.
- **Accounts**: every account in `02-settings-agents` gets the same registrations. Adding an account copies them (`02-settings-agents`).
- **Disable**: a console flag. Claude Code's own switch is per project, and the console wants one switch for all of its sessions. Agent runs pass it as `deniedMcpServers`.
- **Remove**: keeps the entry listed so the operator can Authenticate it again, as the design shows.
- **Status order**: `fail` is worse than `auth`, which is worse than `ok`. `off` only means disabled.
- **Design departure**: the design stores secrets in `~/.ops-console/secrets`; the Keychain holds them instead (ADR 0004).

## Not required

- **Fresh status**: a status can be 60 seconds old. Reconnect forces a new Probe.
- **Disable outside the console**: a `claude` the operator starts in their own terminal still loads a disabled server.
- **Header secrets**: headers live in Claude Code's config in plain text (Behavior 6). The console cannot move them to the Keychain while Claude Code sends them.
- **One sign-in**: with several accounts, Authenticate opens one browser sign-in per account.

## Safety

No change to the agent's reach. The agent cannot add, edit or remove an MCP Server through these endpoints. Only the operator and the setup agent in `05-settings-dev-tools` call them. Sessions the console starts get only enabled servers. Env var values never reach `state.db`, logs or events.

## Database

```sql
CREATE TABLE removed_mcp_servers (
  name        TEXT PRIMARY KEY NOT NULL,         -- no longer in any account's config; still listed
  scope       TEXT NOT NULL,                     -- McpScope
  transport   TEXT NOT NULL,                     -- McpTransport
  target      TEXT NOT NULL,                     -- command or URL; env vars and headers are not kept
  removed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE disabled_mcp_servers (
  name         TEXT PRIMARY KEY NOT NULL,        -- left out of every session the console starts
  disabled_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
```

Enums live in code only (`01-base-daemon-setup`):

| Enum | Values | Used by |
| ---- | ------ | ------- |
| `McpScope` | `user`, `project`, `local` | `removed_mcp_servers.scope` |
| `McpTransport` | `stdio`, `http`, `sse` | `removed_mcp_servers.transport` |
| `HealthStatus` | `ok`, `auth`, `fail`, `off` | `McpServer.status`; `connectors` and `connections` reuse it |
| `CheckTarget` | `mcp_server`, `connector`, `connection` | `connection.checked` |

Migration of existing rows: none; both tables are new.

## API

### Common

Envelopes, auth and shared error codes come from `01-base-daemon-setup`.

`McpServer`:

```json
{
  "name": "string",
  "scope": "user | project | local",
  "repo_id": "uuid | null",          // project scope: the Repo whose .mcp.json holds it
  "transport": "stdio | http | sse",
  "target": "string",                // command or URL, without the launcher prefix
  "config_file": "string",           // ~/.claude.json or <repo>/.mcp.json
  "auth": "none | oauth | headers",
  "status": "ok | auth | fail | off",
  "status_detail": "string | null",
  "tools": ["string"],               // empty unless ok
  "tool_count": 0,
  "env_keys": ["string"],
  "has_headers": false,
  "enabled": true,
  "registered": true,
  "used_by": "string | null"         // Connector id
}
```

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /mcp-servers` | | `McpServer[]`; `meta.connection_server_count` |
| `POST /mcp-servers` | `{ name, transport, target, scope, repo_id?, env?, headers? }` | 201 `McpServer`; `duplicate`, `upstream_failed`; `validation_failed` when project scope has no `repo_id` |
| `PATCH /mcp-servers/:name` | `{ enabled?, transport?, target?, scope?, env?, headers? }` | `McpServer` |
| `POST /mcp-servers/:name/checks` | | `McpServer` after a new Probe (Reconnect) |
| `POST /mcp-servers/:name/auth` | | 202; `connection.checked` reports the result |
| `DELETE /mcp-servers/:name/credentials` | | `McpServer` with `registered: false`, `status: auth` (Remove) |

`env` is `{ "KEY": "value" }`; `headers` is `{ "Name": "value" }`. Neither is ever returned. Item responses are `{ "data": McpServer }`, as in the other specs; `DELETE …/credentials` answers 200 with the row.

### WebSocket `connection.checked`

Server to client, after a check, sign-in or Reconnect of an MCP Server, Connector or Connection. `04-settings-connectors` and `05-settings-dev-tools` send it too.

```json
{
  "target": "mcp_server | connector | connection",
  "id": "string",
  "status": "ok | auth | fail | off",
  "detail": "string | null",
  "latency_ms": "number | null"
}
```

## UI

Settings › MCP servers, as designed: one row per server with name, scope and target, a status glyph (connected, needs authentication, failed, disabled), tool count, and an action (Authenticate, Reconnect or Manage). Below the list, the note on database servers links to Dev tools. The drawer shows read-only details, the tool list ("Tools are listed once the server is connected"), Reconnect, Disconnect or Enable, and Remove with a confirm that shows the `claude mcp remove` command.

- Loading: rows as placeholders until the first Probe answers.
- Empty: "No MCP servers yet" with Add server.
- Error: a row whose Probe failed shows the start error under the target.

## Rejected

- **Env vars passed to `claude mcp add -e`**: Claude Code would keep them in its config in plain text.
- **A copy of the server list in `state.db`**: the operator also edits servers with the CLI, so a copy drifts. Only removed and disabled names are stored.
- **`claude mcp list` for status**: it checks one account and spawns every server each time. A Probe gives status and tools per account in one pass.
- **Claude Code's per-project disable**: it would need one write per Repo per account, and misses sessions outside a Repo.

## Glossary

- **Probe**: A short Agent SDK session that reads which MCP Servers connect and which tools they give, then stops before the model runs.
- **MCP Server** (changed): A server registered in Claude Code that gives the agent tools (Slack, Atlassian, a database). The console registers it in every Claude account.

## ADR

- **0004, amended: MCP headers stay with Claude Code**: secrets live in the Keychain, except headers for http and sse MCP servers. Claude Code sends those itself and keeps them in its own config file, so the console cannot hold them. The form warns and suggests OAuth (Behavior 6). Considered: refusing secret headers, which blocks servers that only take an API key header.

## Seams

- **Backend + SQLite, over HTTP** (fakes for the `claude` CLI wrapper, the Probe and the Keychain adapter): 1 to 15.
- **Backend + SQLite, over WebSocket**: 16.
- **Launcher process**: 4, 15. Runs `ops-console mcp-exec` against a fake Keychain and a stub command, and asserts the child's env and that nothing is printed.

## Out of scope

- Servers that back a Connection: `05-settings-dev-tools`.
- Connector sign-in screens, which call these endpoints: `04-settings-connectors`.
- Copying registrations to a newly added account: `02-settings-agents`.
- Project scope, `used_by`, Connection-backed servers (`connection_server_count` reads 0) and terminals leaving out disabled servers: each waits for the spec that adds the thing it needs. A project scope request is refused with `validation_failed`.
- Claude Code's approval prompt for project `.mcp.json` servers: shown as `auth` with the detail "pending approval in Claude Code"; approving stays in Claude Code.
