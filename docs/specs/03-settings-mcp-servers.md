# Settings: MCP servers

**Status:** shipped
**Design:** the design's MCP servers tab and its detail, shown as a pane beside the list, (Details, Tools, Reconnect, Disconnect, Remove), merged with Connectors into Integrations. The design's add and edit form is left out: Connectors add servers (Behavior 17)

## Problem

The agent works through MCP Servers registered in Claude Code. The operator has no way to see which ones are connected, which need auth, and which failed to start, short of running `claude mcp list` in each Claude account. Adding a server by hand puts its API keys in Claude Code's config file in plain text, and a server added in one account is missing in the others.

This spec gives the operator one list across every account, and add, edit, authenticate, reconnect, disable and remove from the console. The console registers each server with the `claude` CLI so the agent connects on its own (ADR 0005, `01-base-daemon-setup`).

## Behavior

1. Listing MCP Servers reads every Claude account's config (user and local scope), merged by name. Project-scoped servers from each Repo's `.mcp.json` join the list. Each entry shows transport, command or URL, scope, status, tool count, and the Connector using it (`used_by`) when one matches.
2. Servers that back a Connection are left out. `meta.connection_server_count` says how many there are; the Connections page lists their Connections (`05-settings-dev-tools`).
3. Status comes from a Probe per account. A server's status is the worst across accounts (`fail`, then `auth`, then `ok`): a run moves to another account when the active one runs low, so an account still waiting for a sign-in reads `auth` even while it is not active. An account still `checking` does not hide another's `ok`; `status_detail` names the account and the error. With no signed-in Claude account a server reads `fail`, "no signed-in Claude account". A disabled server reads `off`. Probe results are kept in memory. Probes run one at a time across accounts, since each starts every server in its config, and each waits up to 30 seconds: a server still starting then reads "did not finish starting", and the others read as they stand. The daemon starts the first Probes when it starts. A read never waits for a Probe: it answers in under 200 ms from the kept one, or `checking` before the first. A kept Probe older than 60 seconds, or one taken before a server was added, is run again in the background. Each server whose reading moves sends `connection.checked`, and the list reads again. Add, edit and Reconnect answer with `checking` the same way.
4. Adding a server takes name, transport, command or URL, scope, and env vars (stdio) or headers (http, sse). Env vars go to the Keychain adapter under `mcp:<name>`. A stdio server with env vars is registered as `ops-console mcp-exec <name> -- <command>`; at launch that wrapper reads the env vars from the Keychain and starts the command with them. A stdio server with none is registered as its own command. The console runs `claude mcp add` in every account's config dir (user scope, or local scope in the folder `mcp-local` of the data folder) or writes the Repo's `.mcp.json` once (project scope, once `06-settings-repos` lands), then checks the server.
5. If registering fails in any account, the accounts already done are rolled back, the Keychain entry is deleted, and the response is `upstream_failed`.
6. Headers for http and sse servers are passed to `claude mcp add --header`. Claude Code sends them itself, so it keeps them in its own config file in plain text. The API takes them; the tab adds no server with headers.
7. A name already used by a server, a removed server or a Connection is refused with `duplicate`.
8. Editing changes transport, command or URL, scope, env vars or headers; blank fields keep their value; the name cannot change. A change registers the server again in every account and checks it. A new transport without a new command or URL, and a move to or from project scope, are refused with `validation_failed`; a server changes project scope by being added again.
9. Authenticate runs `claude mcp login <name>` in each signed-in account whose kept reading is `auth`, the active account first, one after another; each opens its sign-in in the browser. With no reading kept yet, the console first connects that one server alone in the account, which takes a second or two where a Probe starts every server. It runs in a pseudo-terminal, because `claude mcp login` refuses to start without one. Each account keeps its own token, so each signs in once, and a run that moves to another account keeps the server. On success the status is `ok` at once, and a one-server read brings the tools. A cancelled or failed sign-in leaves it `auth`, with Claude Code's reason when it gives one.
10. Reconnect starts a new Probe and reloads the tools. A server registered in some accounts but not others is first registered in the missing ones, copied from an account that has it. Reconnect on a removed server is refused with `invalid_state`; Authenticate adds it again (Behavior 13).
11. Disable keeps the server out of every agent run the console starts. The setup terminal loads only the console's own setup server, so it never sees one. Its config and login stay, and its status reads `off`. Enable undoes it.
12. Remove stores name, scope, transport and target in `removed_mcp_servers` and answers at once. The list shows it with `registered: false` and status `auth`. In the background it runs `claude mcp logout` and `claude mcp remove -s <scope>` in every account at the same time, deletes the `mcp:<name>` Keychain entry, then sends `connection.checked`. If that fails, the server lists as registered again, and the event carries `fail` with "not removed: …".
13. Authenticate on a removed server registers it again from that row, signs in, and deletes the row. A stdio server that needed env vars is refused, because its env vars were cleared; a Connector's server is added again by connecting its Connector.
14. A server added or removed outside the console (in a terminal) shows up or drops out on the next list, unless it is in `removed_mcp_servers`.
15. No response, event or log carries an env var value or a header value. Reads show `env_keys` (names only) and `has_headers`.
16. Every check, sign-in and Reconnect sends `connection.checked` with target `mcp_server`.
17. Integrations holds Connectors and MCP Servers in one list, each row labelled `Connector` or `MCP`. An MCP Server gives Claude tools; a Connector signs the operator in to a service and registers that service's server (`04-settings-connectors`). The list adds no server itself. A Connector's row stands for its server (`used_by`), connected or not, so that server has no row of its own; any other server, including one registered by hand, by a Repo's `.mcp.json` or by the Setup agent, gets an `MCP` row. Every row has the same columns: name and label with a line under it, status, and one text action (Connect, Sign in, Reconnect or Manage). A Connector that is off reads "not connected".
18. The picked row lives in the address, `?open=connector:<id>` or `?open=mcp:<name>`, so Back, Forward, a reload, a copied link and the sidebar's Integrations link open the same pane. Close clears it.
19. The sidebar's Integrations badge counts the Connectors and the listed MCP Servers (those no Connector stands for) that read `auth` or `fail`, removed servers included. With none, it shows no badge.
20. Adding refuses, with `validation_failed`, env vars on an http or sse server, headers on a stdio one, an http or sse target that is not a URL, a stdio target with no command, and a name with characters other than letters, digits, dot, dash and underscore.

## Settled

- **Probe**: an Agent SDK session started with one account's config dir. It asks Claude Code for each MCP Server's state, error and tools once none is pending, and stops before any model turn. No tokens are spent. Around a sign-in or a Connector check it can connect one server alone instead, with the account's stored token. A stdio server that fails on that first start is started once more, since `npx -y` may still be downloading it.
- **Listing**: the servers an account registers are read from its `.claude.json`; `claude mcp list` starts every server, so it is never used. Signed-out accounts get registrations but no Probe.
- **Launcher**: `ops-console mcp-exec <name> -- <command>` is the stdio launch command for every server whose secrets the console holds, Connections included (`05-settings-dev-tools`). It reads the Keychain at launch, so secrets reach the server process and nothing else. Its path comes from `OPS_CONSOLE_LAUNCHER`, and defaults to the installed `~/.ops-console/current/bin/ops-console`.
- **Env var storage**: all of a server's env vars are one JSON object under the Keychain key `mcp:<name>`.
- **Accounts**: every account in `02-settings-agents` gets the same registrations. Adding an account copies them (`02-settings-agents`).
- **Disable**: a console flag. Claude Code's own switch is per project, and the console wants one switch for all of its sessions. Agent runs pass it as `deniedMcpServers`.
- **Remove**: keeps the entry listed so the operator can Authenticate it again, as the design shows.
- **Status order**: `fail` is worse than `auth`, which is worse than `ok`. `off` only means disabled.
- **Design departure**: the design stores secrets in `~/.ops-console/secrets`; the Keychain holds them instead (ADR 0004).

## Not required

- **Fresh status**: a status can be 60 seconds old until the background Probe answers. Reconnect starts a new one.
- **Disable outside the console**: a `claude` the operator starts in their own terminal still loads a disabled server.
- **Header secrets**: headers live in Claude Code's config in plain text (Behavior 6). The console cannot move them to the Keychain while Claude Code sends them.

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
| `HealthStatus` | `ok`, `auth`, `fail`, `off`, `checking` | `McpServer.status`; `connectors` and `connections` reuse it. `checking` is an MCP Server no Probe has read yet, never stored |
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
  "status": "ok | auth | fail | off | checking",
  "status_detail": "string | null",  // env var and header values masked as ***
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
| `POST /mcp-servers` | `{ name, transport, target, scope, repo_id?, env?, headers? }` | 201 `McpServer`; `duplicate`, `upstream_failed`; `validation_failed` when project scope has no `repo_id` (Behavior 20) |
| `PATCH /mcp-servers/:name` | `{ enabled?, transport?, target?, scope?, env?, headers? }` | `McpServer`; `validation_failed` (Behavior 8) |
| `POST /mcp-servers/:name/checks` | | `McpServer` as it reads now; a new Probe runs in the background (Reconnect). `invalid_state` for a removed server |
| `POST /mcp-servers/:name/auth` | | 202; `connection.checked` reports the result. `invalid_state` for a removed stdio server |
| `DELETE /mcp-servers/:name/credentials` | | `McpServer` with `registered: false`, `status: auth` (Remove) |

`env` is `{ "KEY": "value" }`; `headers` is `{ "Name": "value" }`. Neither is ever returned. Item responses are `{ "data": McpServer }`, as in the other specs; `DELETE …/credentials` answers 200 with the row. An unknown name answers `not_found`.

### WebSocket `connection.checked`

Server to client, after a check, sign-in or Reconnect of an MCP Server, Connector or Connection. `04-settings-connectors` and `05-settings-dev-tools` send it too.

```json
{
  "target": "mcp_server | connector | connection",
  "id": "string",
  "status": "ok | auth | fail | off | checking",
  "detail": "string | null",
  "latency_ms": "number | null"
}
```

## UI

Integrations, below the Connectors (`04-settings-connectors`), A→Z by name: one row per server no Connector stands for, with the name, an `MCP` label, and under it scope, target and tool count. The status pill reads ● connected, ◐ needs auth, ✕ failed, ○ disabled or ◐ removed. The action is Sign in for a server that needs auth or a removed http or sse one, Reconnect for a failed one, and Manage otherwise. The page header's "Add with Setup agent →" opens the Setup agent (`05-settings-dev-tools`). Picking a row opens a pane beside the list (Behavior 18) with Close, read-only Details (name, the Connector that signs it in, scope, transport, command or URL, config file, auth, status and its detail, env var names, and "set (values are never shown)" for headers), the tool list A→Z ("Tools are listed once the server is connected."), Reconnect, Disconnect or Enable, and Remove with a confirm that shows the `claude mcp remove` command. A removed server's pane has Details and Tools only. The list and the pane scroll on their own.

- Loading: "Loading integrations…" until both lists answer.
- Checking: a row reads "◌ checking" until the first Probe answers.
- Error: a row whose Probe failed shows the start error in place of scope and target. A list that does not load reads "Could not read MCP servers: <reason>".

## Rejected

- **Env vars passed to `claude mcp add -e`**: Claude Code would keep them in its config in plain text.
- **A copy of the server list in `state.db`**: the operator also edits servers with the CLI, so a copy drifts. Only removed and disabled names are stored.
- **`claude mcp list` for status**: it checks one account and spawns every server each time. A Probe gives status and tools per account in one pass.
- **Claude Code's per-project disable**: it would need one write per Repo per account, and misses sessions outside a Repo.

## Glossary

- **Probe**: A short Agent SDK session that reads which MCP Servers connect and which tools they give, then stops before the model runs.
- **MCP Server** (changed): A server registered in Claude Code that gives the agent tools (Slack, Atlassian, a database). The console registers it in every Claude account.

## ADR

- **0004, amended: MCP headers stay with Claude Code**: secrets live in the Keychain, except headers for http and sse MCP servers. Claude Code sends those itself and keeps them in its own config file, so the console cannot hold them. The API takes them (Behavior 6); the tab adds none. Considered: refusing secret headers, which blocks servers that only take an API key header.

## Seams

- **Backend + SQLite, over HTTP** (fakes for the `claude` CLI wrapper, the Probe and the Keychain adapter): 1 to 15, 20.
- **Backend + SQLite, over WebSocket**: 16.
- **Launcher process**: 4, 15. Runs `ops-console mcp-exec` against a fake Keychain and a stub command, and asserts the child's env and that nothing is printed.
- **Browser** (Playwright, the lists answered by the test): 17 to 19.

## Out of scope

- Servers that back a Connection: `05-settings-dev-tools`.
- Connector sign-in screens, which call these endpoints: `04-settings-connectors`.
- Copying registrations to a newly added account: `02-settings-agents`.
- Repo terminals leaving out disabled servers: no Repo terminal exists yet; the spec that adds one owns it.
- Claude Code's approval prompt for project `.mcp.json` servers: shown as `auth` with the detail "pending approval in Claude Code"; approving stays in Claude Code.
