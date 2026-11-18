# Google Workspace Connectors

**Status:** shipped
**Design:** the Integrations page's Connector pane in `design/ops-console.html`, unchanged: one sign-in step.

## Problem

The operator keeps notes, runbooks and figures in Google Docs, Sheets and Drive, and the agent cannot read or edit them. Each of the three needs its own Connector, so the operator can connect Sheets without giving the agent Drive. Connecting is one click and one Google account, once. After that every Claude account the console uses, and CLIProxy, reaches the same Google data: the Google sign-in belongs to the console, not to a Claude account.

## Behavior

1. Listing Connectors returns twelve in the fixed order. The last three are `google_docs`, `google_sheets` and `google_drive`. The migration seeds each with status `off` and the config `{}`.
2. A Google Connector reaches its product's REST API (Docs, Sheets or Drive) through a small bridge the console ships: a stdio MCP server with tools of the console's own. The console registers the bridge as an MCP Server named `google-docs`, `google-sheets` or `google-drive` in every Claude account's config, signed in or not. The launcher (`mcp-exec`) hands the bridge the Connector's sign-in from the Keychain as environment variables; the bridge mints an access token and makes each tool's calls to Google. No token is written to a Claude config or a transcript.
3. Connect takes no body and answers 202. The console runs Google's sign-in itself: the authorization code flow with PKCE, a loopback redirect on a port the console picks, Google's account chooser and consent screen in the operator's browser. `sign_in` holds `{ "code": null, "url": <Google's page> }` and each change sends `connection.checked`. When Google returns, the console keeps the refresh token in the Keychain, registers the server in every account, and the Connector reads `ok`. `account_label` shows the Google account's email.
4. The client the sign-in uses is the one the build ships: its id and secret come from the build, never from git and never typed by the operator. A build with no client ends a Google Connect at `auth`: "Google sign-in is not set up in this build".
5. Each Connector signs in on its own and may use a different Google account. A Connector's scopes are its product's only (Settled).
6. A Connect not finished after 5 minutes ends `auth`: "<name> sign-in did not finish within 5 minutes". Cancel stops the wait and keeps the status the Connector had. Google reporting an error (the operator declined) ends `auth` with Google's reason. Connect on a Connector that is already waiting starts its wait again. Several Google Connectors may wait at once.
7. A check reads the refresh token from that Keychain entry and mints an access token from it. It succeeds: `ok`. Google answers `invalid_grant` (revoked, expired, password changed): `auth`, "<name> needs signing in again". Google does not answer: `fail`. A check does not start the server.
8. A connected Google Connector is checked again in the background when its last check is older than 10 minutes (`04-settings-connectors` Behavior 12).
9. Disconnect revokes the token at Google unless another connected Google Connector signed in with the same Google account (Google ties the grant to the account, so revoking would sign that one out too); a failure to reach Google does not stop it. It deletes the Keychain entry, unregisters the server from every account, sets the Connector `off`, clears `status_detail`, and stops a wait. The other Google Connectors are untouched.
10. The Setup agent can start a Google Connect through the same code as the endpoint. The sign-in page opens for the operator: the agent never sees a code or a token.
11. A chat Session gets the tools of each connected Google Connector, whichever Claude account the run uses and whether or not CLIProxy is on. A Job (a Verification, Fix, Agent Review, Reply check or Comment pass) gets none of them, whatever the Playbook holds.
12. In a chat Session, a Google tool call follows the Session's Access mode exactly as a Slack or Atlassian call does. The console adds no read or write rule of its own beyond Behavior 13.
13. Drive's tools only read: the bridge has no tool that deletes a file, empties the trash or changes who may open one, so no Access mode, `full` included, can do either.
14. When Google answers a call with `401`, the bridge mints a new access token and sends that call once more. If Google still refuses, the tool gets Google's error as its result. A call Google refuses or a tool given arguments it cannot use ends as a tool error the agent reads, never as a crash of the bridge.
15. The nine earlier Connectors, Slack's sign-in and their checks, Disconnects and the agent's reach through them do not change.

## Settled

- **Reach** (ADR 0005, through a server registered with Claude Code): the bridge, one stdio MCP Server per Connector, calling the product's REST API. Not claude.ai's connectors, not Google's MCP servers, not a CLI, no `run_integration` entry.

  | Connector | REST API | Scope | Tools |
  | --------- | -------- | ----- | ----- |
  | `google_docs` | `docs.googleapis.com` | `documents` | `get_document`, `create_document`, `append_text`, `replace_text` |
  | `google_sheets` | `sheets.googleapis.com` | `spreadsheets` | `get_spreadsheet`, `get_values`, `update_values`, `append_values`, `create_spreadsheet` |
  | `google_drive` | `drive.googleapis.com` | `drive.readonly` | `search_files`, `get_file`, `read_file` |

  Each also asks `openid` and `email`, to show the account. Each scope is the one its tools need and no wider; the list is pinned in `shared` and a test holds it. A tool takes a link or an id. `get_document` returns the title and text, and `read_file` a Google Doc as text, a Google Sheet's first sheet as CSV and a text file as it is, each cut at 100,000 characters; a binary file or one over 1 MB is refused. Drive's Connector reads every file the account can open; Docs and Sheets reach the files the operator gives them, by link or id.
- **Names and order**: "Google Docs", "Google Sheets", "Google Drive", appended after slashdocs in the fixed order. The Integrations list stays A→Z. `via` reads "Google Docs API" and so on.
- **Client**: one Google OAuth client of type Desktop app, shipped in the build. Packaging writes `google-client.json` from the repo secrets `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`; `pnpm dev` reads `OPS_CONSOLE_GOOGLE_CLIENT_ID` and `OPS_CONSOLE_GOOGLE_CLIENT_SECRET`. A desktop client's secret is not confidential to Google. The project publishes the consent screen "In production": an unverified app shows Google's warning screen once and is capped at 100 users. In "Testing" status Google ends a refresh token after 7 days, which this design does not accept. The Cloud project enables the Docs, Sheets and Drive APIs, and needs no billing account.
- **Redirect**: `http://127.0.0.1:<port>/`, the port picked at Connect, closed when the sign-in ends. A Desktop client takes any loopback port, so two sign-ins can run at once.
- **Keychain** (ADR 0004): the launcher's entry for the server, `mcp:google-docs` and so on, holding the client id, the client secret and the refresh token. Nothing else is stored.
- **Drive stays read-only**: the bridge does not offer the calls, so there is no rule to pin. A test holds the Drive tool list to the three reads.
- **Tool annotations**: each tool says whether it only reads (`readOnlyHint`), so Claude Code can tell a read from a write.
- **Jobs**: the console leaves the three servers out of a Job's MCP set by name. A Playbook cannot add them.
- **Seeded config**: `{}`.
- **Concurrency**: several Google sign-ins at once; several Sessions may use connected Google servers at once.

## Not required

- **Workspace admin approval**: a Superfans-style Workspace may block third-party apps until its admin allows the client id. The sign-in then ends `auth` with Google's reason.
- **Google verification**: the app runs unverified (Settled). A later step may put the client through Google's review to drop the warning and the cap. `drive.readonly` is a restricted scope, so that review is a security assessment.
- **More tools**: Docs formatting, tables and comments, Sheets formatting and charts, and Drive writes (uploads, moves, sharing). Each is a later change.
- **Calendar and Gmail**: each is its own Connector on the same bridge, in a later spec.
- **Google tools in Jobs**: Monitor, Verify and Fix use Datadog, GitHub and the rest, not Google.

## Safety

The agent gets up to three more tool sets in chat Sessions, and its write rights on them are the Access mode's. It cannot connect a Connector. The refresh token stays in the Keychain, and the bridge, a process Claude Code starts outside the Run sandbox, is the only reader besides the console. The agent never holds a token: the bridge keeps an access token in memory while it runs, for an hour at most. Drive can only be read. Jobs gain nothing. PROD connections are unaffected: the Google servers are not Connections.

## Database

```sql
-- No new table. The connectors table gained three rows (0040); the config is empty (0041).
```

`ConnectorId` has `google_docs`, `google_sheets`, `google_drive`. A Keychain entry an earlier build made for a client the operator typed is left where it is, unused. A `google-docs` server an earlier build registered in a Claude config is replaced by the bridge at the next registration.

## API

No endpoint is added. `POST /connectors/:id/connect`, `POST /connectors/:id/checks`, `DELETE /connectors/:id/sign-in` and `DELETE /connectors/:id/credentials` work as in `04-settings-connectors`. A Google Connector's `sign_in` is `{ "code": null, "url": "https://accounts.google.com/..." }` while it waits.

## UI

Integrations, the three rows follow the others: name, `Connector` label, `via`, status pill and one action. The pane is the one numbered step of `04-settings-connectors`, "1 Sign in to Google Drive" and so on. Its text reads "Opens Google in your browser. Pick the Google account to use; every Claude account uses it." While waiting it shows the "Open Google ↗" link and Cancel. Connected, the row shows the Google email. Disconnect reads "Stops the console using it and takes its access back at Google. Every Claude account loses it." Nothing is entered. `status_detail` shows under the step.

- Loading, empty and error follow `04-settings-connectors`.
- The Connector row never shows PROD.

## Rejected

- **Google's remote MCP servers** (`docsmcp`, `sheetsmcp`, `drivemcp.googleapis.com`), relayed by the bridge: Developer Preview, and Google asks a billing account on the Cloud project before the API can be enabled. The console is open source, and nobody who runs it should need a billing account.
- **claude.ai's Google connectors**: tied to one Claude account, so Auto-switch to another account loses the tools; off whenever CLIProxy sends a token; the status said "connected" for runs that had no tools.
- **Claude Code's own OAuth for the Google servers**, with the shipped client: the sign-in is kept per Claude account, so each account signs in again.
- **The operator brings their own client, entered in the pane**: four steps and a Google Cloud project before the first Connect.
- **`gws`, Google's Workspace CLI**: the operator would still bring a Cloud project and `gcloud`, the console would need a `run_integration` allowlist, and the three could not be connected apart.
- **A sub-run on the claude.ai account that does the Google calls for the others**: an extra Claude call and a summarised answer for each request.
- **One "Google" Connector**: the operator asked for three standalone ones.

## Glossary

- **Connector**: the list gains Google Docs, Google Sheets and Google Drive.
- **Google bridge**: the stdio MCP Server the console registers for a Google Connector. It keeps nothing on disk: the launcher hands it the refresh token from the Keychain, and it mints access tokens and answers each tool call from the product's REST API.

## ADR

- **0005 rewrite, in place**: Google's Connectors are reached through the console's bridge, an MCP server over Google's REST APIs, with the console owning the sign-in, so no Claude account holds it. claude.ai's connectors, Google's remote MCP servers, Claude Code's own OAuth, the typed client and `gws` join Considered Options, with why they lost (Rejected). No new ADR.

## Seams

- **Backend + SQLite, over HTTP** (the scripted `ConnectorTools` fake, a fake Google: authorization page, token endpoint and revoke on loopback): 1 to 10, 15.
- **Backend + SQLite, over WebSocket**: 3, 6.
- **Bridge** (`google-bridge.test.ts`: the bridge over stdio against the fake Google's token endpoint and REST APIs): 2, 13, 14.
- **Agent guards** (`agent-guards.test.ts`): 11, 12.
- **Browser** (Playwright, the Connectors answered by the test): UI.

## Out of scope

- Calendar, Gmail and other Workspace products.
- Google tools in Jobs and Playbooks.
- Google's app verification.
