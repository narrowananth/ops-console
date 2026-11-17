# Google Workspace Connectors

**Status:** shipped
**Design:** the Integrations page's Connector pane in `design/ops-console.html`. Departs from it with a client form step, which no other pane has.

## Problem

The operator keeps notes, runbooks and figures in Google Docs, Sheets and Drive, and the agent cannot read or edit them. Each of the three needs its own Connector, so the operator can connect Sheets without giving the agent Drive. Google ships no OAuth client a public repo can bundle, so the operator has to bring one, once, and the three Connectors share it.

## Behavior

1. Listing Connectors returns twelve in the fixed order. The last three are `google_docs`, `google_sheets` and `google_drive`. The migration seeds each with status `off` and the config `{ "client_id": "" }`.
2. Saving the Google OAuth client takes a client ID and a secret. It writes the ID into the config of all three Google Connectors and the secret to the Keychain, so one save serves all three. A blank ID or secret returns `validation_failed` naming the fields and saves nothing. No response, event or log carries the secret.
3. Saving a client is refused with `google_client_in_use` while any Google Connector reads `ok`: Disconnect them first. A Google Connector that reads `auth` or `fail` does not block it, so a mistyped client can be fixed.
4. Connect on a Google Connector with no saved client registers nothing, opens no browser, and ends `auth` with "enter the Google OAuth client in the pane first". The same holds when the Setup agent starts the Connect.
5. Connect with a saved client registers that Connector's MCP Server (`google-docs`, `google-sheets` or `google-drive`) in every Claude account, again each time, because Claude Code's config holds the client ID but not the secret, and the secret may have changed. It turns the server on if it was off, then runs its Authenticate in the active account. The browser sign-in opens within a second of the click. The secret reaches `claude mcp add` through the environment, never as an argument, and the callback port is fixed (Settled).
6. While the sign-in waits on the operator, `sign_in` holds the page the sign-in printed, and each change sends `connection.checked`. `sign_in` is `null` once it ends. When it ends, the console runs a check and records it. The status follows the server's. `login` and the account label stay empty, because the servers give no account.
7. Only one Google sign-in waits at a time. Connect on a Google Connector while another one waits returns 409 `sign_in_in_progress`, naming the other, and starts nothing. Connect on the same Connector restarts its own sign-in (`04-settings-connectors` Behavior 15).
8. A check reads that one server alone in the active account. When Google refuses it, the status is `auth` with Google's reason in `status_detail`. Typical reasons: the operator's Cloud project is not in Drive's developer preview, the product API or its MCP API is not enabled, or the redirect URI is not on the client.
9. A Google Connector whose server is turned off in Integrations reads `fail`, "<server> is turned off in MCP servers". Connect turns it back on. A check of one whose server is not registered reads `auth`, "<server> is not registered" (`04-settings-connectors` Behavior 16).
10. Disconnect removes that Connector's server, sets it `off`, clears `status_detail`, and stops a sign-in still waiting. It leaves the other two Google Connectors and the client alone. When it leaves all three `off`, it also clears `client_id` in the three configs and deletes the secret from the Keychain.
11. A chat Session gets the tools of each Google server that is on. A Job (a Verification, Fix, Agent Review, Reply check or Comment pass) gets none of them, whatever the Playbook holds.
12. In a chat Session, a Google tool call follows the Session's Access mode exactly as a Slack or Atlassian call does. The console adds no read or write rule of its own beyond Behavior 13.
13. Drive's delete and share tools are denied in every Access mode, `full` included. The agent gets the denial as the tool's result.
14. The Setup agent can start a Google Connect through the same code as the endpoint. It has no tool that reads or sets the client or its secret.
15. The Connector pane shows four steps: create the client, enable the APIs, enter the client, Connect. The client step reads done in all three Google panes once saved, and the form returns after the last Disconnect.
16. The nine earlier Connectors, Slack's sign-in (callback port 3118 included) and their checks, Disconnects and the agent's reach through them do not change.

## Settled

- **Reach** (ADR 0005, through a tool Claude also uses): each Connector registers one of Google's own remote MCP Servers over HTTP. No CLI, no `run_integration` entry.

  | Connector | MCP Server | Target | APIs to enable |
  | --------- | ---------- | ------ | -------------- |
  | `google_docs` | `google-docs` | `https://docsmcp.googleapis.com/mcp/v1` | `docs.googleapis.com`, `docsmcp.googleapis.com` |
  | `google_sheets` | `google-sheets` | `https://sheetsmcp.googleapis.com/mcp/v1` | `sheets.googleapis.com`, `sheetsmcp.googleapis.com` |
  | `google_drive` | `google-drive` | `https://drivemcp.googleapis.com/mcp/v1` | `drive.googleapis.com`, `drivemcp.googleapis.com` |

- **Names and order**: "Google Docs", "Google Sheets", "Google Drive", appended after slashdocs in the fixed order. The Integrations list stays A→Z. `via` reads "Google Docs MCP", "Google Sheets MCP", "Google Drive MCP".
- **Callback port**: `3119` for all three, so the one redirect URI to put on the client is `http://localhost:3119/callback`. Slack keeps 3118.
- **Client**: the operator's own OAuth client from their Google Cloud project, one for all three. The ID is config, the secret is a Keychain entry (ADR 0004). Google's guide asks for the client type "AI-powered agent".
- **Scopes**: the sign-in asks for what each server needs, read and write. There is no read-only sign-in. What the agent may write is the Access mode.
- **Registration**: Connect registers the server again every time. The secret is handed to `claude mcp add` in the environment once per account, so each account's own Claude Code store holds it.
- **Drive denial**: by tool name, the verbs for deleting and sharing and for changing permissions. Google's Drive server has no such tool today, so the rule only holds if it gains one. The test pins the rule list, and `get_file_permissions`, a read, stays allowed.
- **Jobs**: the console leaves the three servers out of a Job's MCP set. A Playbook cannot add them.
- **Concurrency**: one Google sign-in at a time. Two Sessions may use connected Google servers at once.

## Not required

- **Read-only sign-in**: the operator reads and writes with the agent's Access mode as the only limit. Review flags a scope switch.
- **Account shown**: the pane says "connected", not whose account.
- **Editing the client while connected**: the operator Disconnects first (Behavior 3).
- **Google tools in Jobs**: Monitor, Verify and Fix use Datadog, GitHub and the rest, not Google. A later spec may add one.
- **Drive in every project**: while Drive's MCP Server is in developer preview, a project outside it reads `auth` with Google's reason.

## Safety

The agent gets three more MCP Servers in chat Sessions, and its write rights on them are the Access mode's. It cannot connect a Connector or read the client secret: the secret stays in the Keychain and passes to `claude mcp add` through the environment. Drive delete and share are denied in every mode. Jobs gain nothing. PROD connections are unaffected: the Google servers are not Connections.

## Database

```sql
-- No new table. The connectors table gains three rows.
INSERT OR IGNORE INTO connectors (id, status, config) VALUES
  ('google_docs',   'off', '{"client_id":""}'),
  ('google_sheets', 'off', '{"client_id":""}'),
  ('google_drive',  'off', '{"client_id":""}');
```

`ConnectorId` gains `google_docs`, `google_sheets`, `google_drive`. Migration of existing rows: none; a row already there is left as it is.

## API

### Common

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `google_client_in_use` | Save while a Google Connector reads `ok` |
| 409 | `sign_in_in_progress` | Connect on a Google Connector while another Google sign-in waits; `message` names it |

Config shape added to `PATCH /connectors/:id` and `Connector.config`:

```json
{
  "google_docs": { "client_id": "string" },
  "google_sheets": { "client_id": "string" },
  "google_drive": { "client_id": "string" }
}
```

`PATCH /connectors/:id` refuses `client_id` on these three with `validation_failed`: it is set only through the client endpoint.

### `PUT /connectors/google/client`

Body `{ "client_id": "string", "client_secret": "string" }`. Returns the three Google `Connector`s. Errors: `validation_failed`, `google_client_in_use`. The secret is never returned.

### `DELETE /connectors/google/client`

Clears `client_id` in the three configs and the Keychain secret. Returns the three Google `Connector`s. `google_client_in_use` while one reads `ok`.

### `POST /connectors/:id/connect`

For a Google Connector, adds the 409 `sign_in_in_progress` and the `auth` outcome of Behavior 4.

## UI

Integrations, the three rows follow the others: name, `Connector` label, `via`, status pill and one action. The pane keeps the layout of `04-settings-connectors` with four numbered steps in place of one:

1. **Create an OAuth client**: "In your Google Cloud project, create an OAuth client for an AI-powered agent." A link to Google's guide, and the redirect URI `http://localhost:3119/callback` with a copy icon.
2. **Enable the APIs**: the two API names for that Connector (table in Settled), each with a copy icon.
3. **Enter the client**: client ID and client secret fields and Save. Saved, it reads "Client saved" and collapses, in all three panes. After the last Disconnect the fields return empty. A refused save shows the server's message under the step (it ends "Disconnect the Google Connectors first"). Change reopens the form once saved, for a client that failed to connect (Behavior 3).
4. **Connect**: the same step as the other panes (waiting, Cancel, "Connected", Reconnect, Disconnect…). Disabled with "Save the client first" until step 3 is done. While another Google sign-in waits it shows the 409 message under the step.

- Loading, empty and error follow `04-settings-connectors`. `status_detail` shows Google's reason under step 4.
- The Connector row never shows PROD.
- Departure from the design: steps 1 to 3 do not exist in any other pane, and the others have no form.

## Rejected

- **`gws`, Google's Workspace CLI**: one CLI and one sign-in for all three, but the operator would still bring a Cloud project and `gcloud`, the console would need a `run_integration` allowlist, and the three could not be connected apart.
- **One "Google" Connector**: the operator asked for three standalone ones.
- **A client ID and secret bundled in the repo**: the repo is public and Google's secret cannot ship (ADR 0005).
- **A read-only sign-in switch**: the Access mode already decides what the agent writes.
- **One callback port per Connector**: the operator would add three redirect URIs, and the one-at-a-time rule makes them unnecessary.

## Glossary

- **Google OAuth client**: the OAuth client the operator creates in their own Google Cloud project, entered once and shared by Google Docs, Google Sheets and Google Drive. Its ID is config and its secret is in the Keychain; both are cleared when the last of the three is disconnected.
- **Connector**: the list gains Google Docs, Google Sheets and Google Drive. A Connector can ask the operator for a client before Connect when the provider ships none.

## ADR

- **0005 rewrite, in place**: "The operator types no token and fills no form before Connect" gains an exception: a provider that ships no OAuth client a public repo can bundle (Google) has the operator enter their own client once, and the secret goes to the Keychain. The `gws` CLI joins Considered Options, with why it lost (Rejected). No new ADR.

## Seams

- **Backend + SQLite, over HTTP** (the scripted `ConnectorTools` fake, the `claude` CLI and Keychain adapter fakes): 1 to 10, 14, 16.
- **Backend + SQLite, over WebSocket**: 6.
- **Agent guards** (`agent-guards.test.ts`): 11, 12, 13.
- **Browser** (Playwright, the Connectors answered by the test): 15.

## Out of scope

- Google tools in Jobs and Playbooks: a later spec.
- Gmail, Calendar and other Workspace products: each would be its own Connector in a later spec.
- Showing which Google account signed in.
