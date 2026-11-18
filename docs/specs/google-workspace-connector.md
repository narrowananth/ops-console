# Google Workspace Connectors

**Status:** ready
**Design:** the Integrations page's Connector pane in `design/ops-console.html`, unchanged: one sign-in step.

## Problem

The operator keeps notes, runbooks and figures in Google Docs, Sheets and Drive, and the agent cannot read or edit them. Each of the three needs its own Connector, so the operator can connect Sheets without giving the agent Drive. Connecting must work the way it does on claude.ai: Connect, then Google's account chooser and consent screen, with nothing created or entered in Ops Console.

## Behavior

1. Listing Connectors returns twelve in the fixed order. The last three are `google_docs`, `google_sheets` and `google_drive`. The migration seeds each with status `off` and the config `{}`.
2. A Google Connector rides claude.ai's own Google connector, which Claude Code loads in a Claude account signed in with claude.ai, as `claude.ai Google Docs`, `claude.ai Google Sheets` or `claude.ai Google Drive`. The console registers no MCP Server, holds no OAuth client and no secret, and reads no Google account. Google's account chooser and consent screen run on claude.ai.
3. Connect takes no body and answers 202. When the active account already has the connector connected, the Connector reads `ok` at once and nothing opens. Otherwise `sign_in` holds the page `https://claude.ai/new#customize/connectors`, the console opens it in the operator's browser, and each change sends `connection.checked`. The pane keeps an "Open Google Drive ↗" link to the same page.
4. While it waits, the console asks the active account every 3 seconds whether the connector now reads connected. When it does, `sign_in` is `null` and the Connector reads `ok`. Cancel stops the wait and keeps the status the Connector had. A wait that is not over after 5 minutes ends `auth`: "<name> was not connected on claude.ai within 5 minutes".
5. The pane is the single sign-in step the other Connectors have: Connect, Waiting with Cancel, Reconnect and Disconnect. It asks for nothing. Its text says Connect opens claude.ai and that the status updates on its own.
6. A check reads that one connector in the active account, in a second or two. Connected reads `ok`. A connector that needs signing in again reads `auth`, "<name> needs signing in again on claude.ai". A connector the account never added reads `auth`, "<name> is not added on claude.ai. Add it there, with an account signed in through claude.ai". One that does not answer reads `fail`. With no signed-in Claude account it reads `fail`, "no signed-in Claude account".
7. A connected Google Connector is checked again in the background when its last check is older than 10 minutes (`04-settings-connectors` Behavior 12).
8. Two Google Connectors may wait at once; Connect on the same one starts its wait again.
9. Disconnect sets the Connector `off`, clears `status_detail`, and stops a wait. The connector stays added on claude.ai: removing it there is the operator's. The other Google Connectors are untouched.
10. The Setup agent can start a Google Connect through the same code as the endpoint. It cannot add the connector on claude.ai.
11. A chat Session gets the tools of each Google connector that is connected on claude.ai. A Job (a Verification, Fix, Agent Review, Reply check or Comment pass) gets none of them, whatever the Playbook holds.
12. In a chat Session, a Google tool call follows the Session's Access mode exactly as a Slack or Atlassian call does. The console adds no read or write rule of its own beyond Behavior 13.
13. Whatever claude.ai's Google Drive connector offers for deleting a file or changing who may open it is denied in every Access mode, `full` included. The agent gets the denial as the tool's result.
14. A `client_id` that 0.1.58 saved is dropped from the three configs by the migration.
15. The nine earlier Connectors, Slack's sign-in and their checks, Disconnects and the agent's reach through them do not change.

## Settled

- **Reach** (ADR 0005, through a tool Claude also uses): claude.ai's Google connectors, as Claude Code loads them. No MCP Server is registered, no CLI, no `run_integration` entry.

  | Connector | claude.ai connector |
  | --------- | ------------------- |
  | `google_docs` | `claude.ai Google Docs` |
  | `google_sheets` | `claude.ai Google Sheets` |
  | `google_drive` | `claude.ai Google Drive` |

- **Names and order**: "Google Docs", "Google Sheets", "Google Drive", appended after slashdocs in the fixed order. The Integrations list stays A→Z. `via` reads "claude.ai Google Docs" and so on.
- **Read**: `claude mcp get "<claude.ai name>"` in the active account, which connects that one connector. A connector the account never added exits 1 with nothing on stdout.
- **Page**: `https://claude.ai/new#customize/connectors`, the connectors list. The console opens it with the macOS `open` command and keeps a link in the pane.
- **Scopes**: whatever claude.ai's connector asks for. There is no read-only sign-in here; what the agent may write is the Access mode.
- **Drive denial**: by tool name, the verbs for deleting and sharing and for changing permissions, on Claude Code's tool names `mcp__claude_ai_Google_Drive__<tool>`. The test pins the rule list.
- **Jobs**: the console leaves the three connectors out of a Job's MCP set by their `claude.ai ...` names. A Playbook cannot add them.
- **Seeded config**: `{}`. A Keychain entry 0.1.58 made for a client the operator typed is left where it is, unused.
- **Concurrency**: several Google waits at once; several Sessions may use connected Google connectors at once.

## Not required

- **Console accounts only**: claude.ai connectors load only in a Claude account signed in with claude.ai. With CLIProxy as the Claude account hub, or an API key in the environment, Claude Code turns them off and the Connector reads `auth`, "not added on claude.ai".
- **Account shown**: the pane says "connected", not whose Google account.
- **Disconnecting on claude.ai**: the console leaves the connector added there.
- **Several Claude accounts**: only the active account is read. Another account needs the connector added on its own claude.ai login.
- **Google tools in Jobs**: Monitor, Verify and Fix use Datadog, GitHub and the rest, not Google. A later spec may add one.

## Safety

The agent gets up to three more tool sets in chat Sessions, and its write rights on them are the Access mode's. It cannot connect a Connector or add a connector on claude.ai. The console holds no Google credential. Drive delete and share are denied in every mode. Jobs gain nothing. PROD connections are unaffected: the Google connectors are not Connections.

## Database

```sql
-- No new table. The connectors table gained three rows (0040); the config is now empty.
UPDATE connectors SET config = '{}' WHERE id IN ('google_docs', 'google_sheets', 'google_drive');
```

`ConnectorId` has `google_docs`, `google_sheets`, `google_drive`. Migration of existing rows: a `client_id` saved by 0.1.58 is dropped from the three configs.

## API

No endpoint is added. `POST /connectors/:id/connect`, `POST /connectors/:id/checks`, `DELETE /connectors/:id/sign-in` and `DELETE /connectors/:id/credentials` work as in `04-settings-connectors`. A Google Connector's `sign_in` is `{ "code": null, "url": "https://claude.ai/new#customize/connectors" }` while it waits.

## UI

Integrations, the three rows follow the others: name, `Connector` label, `via`, status pill and one action. The pane is the one numbered step of `04-settings-connectors`, "1 Sign in to Google Drive" and so on. Its text reads "Opens claude.ai in your browser. Add Google Drive there, with Connect. This updates on its own." While waiting it shows the "Open Google Drive ↗" link and Cancel. Disconnect reads "Stops the console using it. It stays added on claude.ai: remove it there to take it away from Claude too." Nothing is entered. `status_detail` shows under the step.

- Loading, empty and error follow `04-settings-connectors`.
- The Connector row never shows PROD.

## Rejected

- **A client the build ships** (the first form of this change): needs a Google Cloud project, a verified consent screen and secrets in the release, and its secret ships in the public tarball. claude.ai already runs Google's consent flow on its own verified client.
- **The operator brings their own client, entered in the pane** (0.1.58): four steps and a Google Cloud project before the first Connect.
- **`gws`, Google's Workspace CLI**: the operator would still bring a Cloud project and `gcloud`, the console would need a `run_integration` allowlist, and the three could not be connected apart.
- **One "Google" Connector**: the operator asked for three standalone ones.
- **Polling with a full Probe**: it starts every server in the account. `claude mcp get` reads the one connector.

## Glossary

- **claude.ai connector**: a service the operator adds on claude.ai that Claude Code loads in a Claude account signed in with claude.ai, under the name `claude.ai <Service>`. Google Docs, Google Sheets and Google Drive ride them. The console reads whether one is connected and never holds its sign-in.
- **Connector**: the list gains Google Docs, Google Sheets and Google Drive.

## ADR

- **0005 rewrite, in place**: Google's Connectors are reached through claude.ai's connectors, which Claude Code already loads, so no sign-in or client is the console's. The shipped client, the typed client and `gws` join Considered Options, with why they lost (Rejected). No new ADR.

## Seams

- **Backend + SQLite, over HTTP** (the scripted `ConnectorTools` fake, the `claude` CLI fake with a `claude.ai` file per account): 1 to 10, 14, 15.
- **Backend + SQLite, over WebSocket**: 3, 4.
- **Agent guards** (`agent-guards.test.ts`): 11, 12, 13.
- **Browser** (Playwright, the Connectors answered by the test): 5, 9.

## Out of scope

- Google tools in Jobs and Playbooks: a later spec.
- Gmail, Calendar and other Workspace products: each would be its own Connector in a later spec.
- Showing which Google account signed in.
