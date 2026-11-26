# Render Connector

**Status:** shipped
**Open:** no real Render account ran. Unverified: that a Read only key refuses the write tools, and the wording of Render's refusals. Proved with the real `mcp-remote` against a local stand-in server: `Authorization: Bearer <key>` reaches the MCP address from `RENDER_AUTH`. Not proved: on a 401 `mcp-remote` starts OAuth discovery and waits instead of exiting, so a refused key reads `fail` after the Probe's wait; Behavior 4's `auth` holds only for a failure whose text says 401, 403 or unauthorized. Claude Code expands `${RENDER_AUTH}` in registered args itself: while the variable is unset it leaves the text and warns "Missing environment variables".
**Design:** the Connector pane of Integrations (`design/ops-console.html`): New Relic's pane with its API key field is the model. The Approval card is the existing one.

## Problem

The operator runs services on Render and wants a Session to read them: services, deploys, events, logs, metrics and
databases. When the operator agrees, a Session may also change them: set an environment variable, trigger a deploy. Render
has a hosted MCP server, but it signs in with an API key, and the console must not write that key into a config file
(ADR 0004), so it has no Connector today.

## Behavior

### Connector

1. Integrations lists Render as a twentieth Connector, after Shortcut, with status `off`.
2. Render's pane has one step: an API key field and Connect. The operator creates the key in the Render dashboard and pastes
   it. Connect takes `{ api_key }`, refuses one under 8 characters, and stores it in the Keychain under the server's name. The key
   never appears in a response, event, log, config file or the agent's prompt.
3. Connect registers the `render` MCP Server in every account, started through the launcher as a stdio command that reaches
   `https://mcp.render.com/mcp` with the header `Authorization: Bearer <key>`. The key reaches only that server's process,
   from the Keychain, at start. The status follows the server's.
4. A key Render refuses leaves the status `auth` with Render's reason. The pane offers Reconnect with a new key. A server
   turned off in Integrations reads `fail`, "render is turned off in MCP servers", and Connect turns it back on.
5. Disconnect removes the server and the stored key, and revokes nothing at Render. The pane says to delete the key in
   the dashboard.
6. A Session's own runs can call Render's tools. A job the console starts, and a pull request's Session, do not reach Render:
   a call to its tools under any name Render's server can carry is refused in them before it runs.
7. The agent is told, when Render is connected and the run can use it, which tools read, which change things and ask, and
   which change running services and always ask.

### Tool classes

8. Render's classes are lists of tool names (a server that publishes them, as Notion's does):
   - Read: `list_workspaces`, `get_selected_workspace`, `select_workspace` (a choice the server holds for the session,
     nothing stored at Render), `list_services`, `get_service`, `list_deploys`, `get_deploy`, `list_events`, `list_logs`,
     `list_log_label_values`, `get_metrics`, `list_postgres_instances`, `get_postgres`, `list_key_value`, `get_key_value`,
     `get_blueprint`, and the workflow reads `list_workflows`, `get_workflow`, `list_workflow_versions`,
     `get_workflow_version`, `list_workflow_tasks`, `get_workflow_task`, `list_workflow_runs`, `get_workflow_run`,
     `get_workflow_run_results`, `list_flows`, `get_flow`, `list_flow_runs`, `get_flow_run`, `get_flow_run_results`,
     `list_flow_run_steps`, `get_flow_run_step`.
   - Write: `query_render_postgres` (read-only SQL, which the console treats as a query on a database and asks),
     `create_web_service`, `create_static_site`, `create_cron_job`, `create_postgres`, `create_key_value`, `run_cron_job`,
     `cancel_cron_job_run`, `create_blueprint`, `plan_blueprint`, `update_blueprint`, `create_workflow`,
     `create_workflow_version`, `start_flow_run`, `cancel_flow_run`.
   - Destructive: `trigger_deploy`, `update_environment_variables` (it replaces the whole list), `approve_blueprint`, and
     any tool not listed.
9. Reads run. Writes raise an Approval in every Access mode but `full`. Destructive tools and unlisted tools raise one in
   every mode, `full` included, as for [notion-connector](notion-connector.md) 6 to 10. The Approval names the service,
   the tool and its main inputs (the service, the variable names without values, the SQL text capped), and each call that is not a read writes an
   Action Log row before it runs, with no variable value.
10. The pane tells the operator which key to give: a key with Read only reads, and a key with Read and write also lets the
    approved writes run. A call the key cannot make fails with Render's own message.
11. Render may refuse a call, and the agent receives Render's message. The Connector's status does not change.
12. Figma, Notion and Shortcut keep their own rules. What must not regress: the other nineteen Connectors, the MCP servers
    page, Sessions while Render is not connected (no server starts, nothing about Render in the prompt), the launcher's
    secret handling for GitHub and the Connections, and Approvals of PROD writes and commands.

## Settled

- **Stdio through `mcp-remote`.** The launcher starts `npx -y mcp-remote https://mcp.render.com/mcp --header
  Authorization:${RENDER_AUTH}` with `RENDER_AUTH=Bearer <key>` in its environment, so the key is in the Keychain and in
  one process's environment, as GitHub's token is. `mcp-remote` is the npm package that bridges a stdio client to an HTTP
  server with headers. It starts through the immutable versioned installs of [mcp-package-installs](mcp-package-installs.md).
- **API key, not OAuth.** Render documents OAuth only for its own plugins and clients it names. The manual route it
  documents is the key.
- **Env var carries the whole header value** (`Bearer <key>`), because a space in an argument is not safe through every
  launcher.
- **`update_environment_variables` is destructive.** It replaces the list, and Render's own documentation names it and
  `trigger_deploy` as potentially destructive.
- **Render's tools have no delete.** Render says deletions are done in the dashboard or the REST API. A tool that deletes
  and is added later is unlisted, so it asks.
- **Server names**: the lists apply to the console's `render` server and to Render's under the names a plugin or a claude.ai
  connector gives it, in any case.

## Not required

- **OAuth sign-in** for Render.
- **A key picker or a workspace picker.** The agent chooses the workspace with `select_workspace`, which is a read.
- **Showing which permissions the key has.** Render's answer to a refused call says.
- **A Render REST bridge.**

## Safety

The agent gains Render's tools in the operator's own chat runs. The credential is the operator's key: with Read only it
cannot write whatever the agent asks; with Read and write it can, behind the Approvals above. Reads run; a write needs the
operator's yes except in `full`; a deploy, an environment change and any unlisted tool needs a yes in every mode. Text from
a log, a service name or a pull request cannot start a deploy or an environment change in any mode, nor another write
outside `full`. Jobs and pull request Sessions reach no Render server. The key is in the Keychain and in the one server
process's environment while it runs. `mcp-remote` is a community package; it runs as the operator inside the Run sandbox
like any other server.

## Database

```sql
INSERT INTO connectors (id, status, config) VALUES ('render', 'off', '{}') ON CONFLICT DO NOTHING;
```

One migration, as `0055_connector_notion`. Migration of existing rows: none.

## API

### `GET /connectors`

Returns twenty Connectors in the fixed order, Render after Shortcut. Its `via` reads "Render MCP". Its config is an empty
object, and a `PATCH` with any field answers `validation_failed`. The key is never in a response.

### `POST /connectors/render/connect`

Body `{ "api_key": "<key>" }`, 8 to 200 characters. Answers 202. A missing, blank, shorter or longer key answers `validation_failed`.

### `DELETE /connectors/render/sign-in`, `DELETE /connectors/render/credentials`

Cancel and Disconnect, as for every Connector. Disconnect removes the stored key.

## UI

- **Connector pane**: Render's brand icon, a masked "Render API key" field with a link to the dashboard page that creates
  one, and Connect. A note: "Create the key with Read only to let Sessions read your services, deploys and logs, or with
  Read and write to let approved changes run. A change asks you first, a deploy or an environment change always asks, and
  Full access skips the first." After Connect the field is empty and the pane shows Reconnect and Disconnect.
- **States**: off, connected, `auth` with the reason (a key Render refused), `fail` when the server is off.

## Rejected

- **The key in the server's registered headers.** It would sit in Claude Code's config file in the clear.
- **The key in the agent's environment for a header expansion.** Every command the agent runs would see it.
- **Render's local Go server.** It needs a binary the operator installs.
- **Treat `update_environment_variables` as a write.** One call replaces every variable of a service.

## Glossary

None added or changed.

## ADR

- **Secrets in Keychain** (0004): no change. The key is held as GitHub's token is.
- **Operator approves agent never merges** (0002): Render joins the list of services the agent changes only by asking.

## Seams

- **Classes** (unit): 8, 9.
- **Run guard and Approval** (backend + SQLite, fake agent runtime): 6, 7, 9.
- **Connect, key handling and Disconnect** (backend + SQLite, over HTTP, fake launcher and Keychain): 1 to 5, 12.
- **Header reaches the server** (real `mcp-remote` against a local stand-in HTTP server that records the header): 3.
- **Pane** (frontend e2e, API mocked): 2, 4, UI states.
- **A real Render account** (by hand): 3, 8, 10, 11.

## Out of scope

- OAuth, a REST bridge, a workspace picker, showing the key's permissions.
