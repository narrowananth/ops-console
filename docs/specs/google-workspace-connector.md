# Google Workspace Connectors

**Status:** ready
**Design:** the Integrations page's Connector pane in `design/ops-console.html`, unchanged: one sign-in step.

## Problem

The operator keeps notes, runbooks and figures in Google Docs, Sheets and Drive, and the agent cannot read or edit them. Each of the three needs its own Connector, so the operator can connect Sheets without giving the agent Drive. Connecting must be one click, as it is for the other Connectors and as it is in ChatGPT, so the operator creates and enters nothing. Ops Console ships its own Google OAuth client, shared by the three Connectors, the way Slack's client ID ships.

## Behavior

1. Listing Connectors returns twelve in the fixed order. The last three are `google_docs`, `google_sheets` and `google_drive`. The migration seeds each with status `off` and the config `{ "client_id": "" }`.
2. The Google OAuth client is part of the build: a client ID and a secret read from the daemon's environment (`OPS_CONSOLE_GOOGLE_CLIENT_ID`, `OPS_CONSOLE_GOOGLE_CLIENT_SECRET`) or, in a release, from a file the packaging step wrote from the repo's secrets. The operator enters nothing and no endpoint reads or sets it. No response, event or log carries the secret.
3. Connect in a build with no client registers nothing, opens no browser, and ends `auth` with "Google sign-in is not set up in this build". The same holds when the Setup agent starts the Connect.
4. Connect with a client registers that Connector's MCP Server (`google-docs`, `google-sheets` or `google-drive`) in every Claude account, again each time, because Claude Code's config holds the client ID but not the secret. It turns the server on if it was off, then runs its Authenticate in the active account. The browser sign-in opens within a second of the click. The secret reaches `claude mcp add` through the environment, never as an argument, and the callback port is fixed (Settled).
5. The pane is the single sign-in step the other Connectors have: Connect, Waiting with Cancel, Reconnect and Disconnect. It asks for nothing.
6. While the sign-in waits on the operator, `sign_in` holds the page the sign-in printed, and each change sends `connection.checked`. `sign_in` is `null` once it ends. When it ends, the console runs a check and records it. The status follows the server's. `login` and the account label stay empty, because the servers give no account.
7. Only one Google sign-in waits at a time. Connect on a Google Connector while another one waits returns 409 `sign_in_in_progress`, naming the other, and starts nothing. Connect on the same Connector restarts its own sign-in (`04-settings-connectors` Behavior 15).
8. A check reads that one server alone in the active account. When Google refuses it, the status is `auth` with Google's reason in `status_detail`. Typical reasons: the project that owns the client is not in Drive's developer preview, the client is in Google's testing mode and the operator is not a listed test user, or the sign-in has lapsed.
9. A Google Connector whose server is turned off in Integrations reads `fail`, "<server> is turned off in MCP servers". Connect turns it back on. A check of one whose server is not registered reads `auth`, "<server> is not registered" (`04-settings-connectors` Behavior 16).
10. Disconnect removes that Connector's server, sets it `off`, clears `status_detail`, and stops a sign-in still waiting. It leaves the other two Google Connectors alone.
11. A chat Session gets the tools of each Google server that is on. A Job (a Verification, Fix, Agent Review, Reply check or Comment pass) gets none of them, whatever the Playbook holds.
12. In a chat Session, a Google tool call follows the Session's Access mode exactly as a Slack or Atlassian call does. The console adds no read or write rule of its own beyond Behavior 13.
13. Drive's delete and share tools are denied in every Access mode, `full` included. The agent gets the denial as the tool's result.
14. The Setup agent can start a Google Connect through the same code as the endpoint. It has no tool that reads the client or its secret.
15. The seeded config of the three Google Connectors is `{}`. The migration resets a `client_id` that 0.1.58 saved.
16. The nine earlier Connectors, Slack's sign-in (callback port 3118 included) and their checks, Disconnects and the agent's reach through them do not change.

## Settled

- **Reach** (ADR 0005, through a tool Claude also uses): each Connector registers one of Google's own remote MCP Servers over HTTP. No CLI, no `run_integration` entry.

  | Connector | MCP Server | Target |
  | --------- | ---------- | ------ |
  | `google_docs` | `google-docs` | `https://docsmcp.googleapis.com/mcp/v1` |
  | `google_sheets` | `google-sheets` | `https://sheetsmcp.googleapis.com/mcp/v1` |
  | `google_drive` | `google-drive` | `https://drivemcp.googleapis.com/mcp/v1` |

- **Names and order**: "Google Docs", "Google Sheets", "Google Drive", appended after slashdocs in the fixed order. The Integrations list stays A→Z. `via` reads "Google Docs MCP", "Google Sheets MCP", "Google Drive MCP".
- **Callback port**: `3119` for all three, so the one redirect URI to put on the client is `http://localhost:3119/callback`. Slack keeps 3118. A Desktop-type client allows any loopback port.
- **Client**: one Desktop-type OAuth client, owned by the Ops Console project in Google Cloud and shared by the three. Google treats an installed app's secret as non-confidential. The ID and secret never enter git: the release workflow reads them from the repo's secrets `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, and packaging writes them to `google-client.json` in the app folder. They do ship inside the public tarball. `pnpm dev` reads the two environment variables.
- **Scopes**: the sign-in asks for what each server needs, read and write. There is no read-only sign-in. What the agent may write is the Access mode.
- **Registration**: Connect registers the server again every time. The secret is handed to `claude mcp add` in the environment once per account, so each account's own Claude Code store holds it.
- **Seeded config**: `{}`. The 0.1.58 Keychain entry for a client the operator typed is left where it is, unused.
- **Drive denial**: by tool name, the verbs for deleting and sharing and for changing permissions. Google's Drive server has no such tool today, so the rule only holds if it gains one. The test pins the rule list, and `get_file_permissions`, a read, stays allowed.
- **Jobs**: the console leaves the three servers out of a Job's MCP set. A Playbook cannot add them.
- **Concurrency**: one Google sign-in at a time. Two Sessions may use connected Google servers at once.

## Not required

- **Read-only sign-in**: the operator reads and writes with the agent's Access mode as the only limit. Review flags a scope switch.
- **Account shown**: the pane says "connected", not whose account.
- **Own client**: an operator cannot swap in their own Google client. A later spec may add it.
- **Google's limits**: while the client's consent screen is in testing mode, only listed test users can sign in and tokens lapse after 7 days. Publishing it needs Google's verification.
- **Google tools in Jobs**: Monitor, Verify and Fix use Datadog, GitHub and the rest, not Google. A later spec may add one.
- **Drive for everyone**: while Drive's MCP Server is in developer preview, it works only when the client's project is in Google's program; otherwise it reads `auth` with Google's reason.

## Safety

The agent gets three more MCP Servers in chat Sessions, and its write rights on them are the Access mode's. It cannot connect a Connector. The client secret is in the app folder and passes to `claude mcp add` through the environment; Google treats it as non-confidential, and it ships in the public tarball. Drive delete and share are denied in every mode. Jobs gain nothing. PROD connections are unaffected: the Google servers are not Connections.

## Database

```sql
-- No new table. The connectors table gained three rows (0040); the config is now empty.
UPDATE connectors SET config = '{}' WHERE id IN ('google_docs', 'google_sheets', 'google_drive');
```

`ConnectorId` has `google_docs`, `google_sheets`, `google_drive`. Migration of existing rows: a `client_id` saved by 0.1.58 is dropped from the three configs.

## API

### Common

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `sign_in_in_progress` | Connect on a Google Connector while another Google sign-in waits; `message` names it |

The three Google Connectors have config `{}`. The two client endpoints of 0.1.58 and the `google_client_in_use` error are gone.

### `POST /connectors/:id/connect`

For a Google Connector, adds the 409 `sign_in_in_progress` and the `auth` outcome of Behavior 3.

## UI

Integrations, the three rows follow the others: name, `Connector` label, `via`, status pill and one action. The pane is the one numbered step of `04-settings-connectors`, "1 Sign in to Google Drive" and so on. Nothing is entered. While another Google sign-in waits, the 409 message shows under the step, and `status_detail` shows Google's reason.

- Loading, empty and error follow `04-settings-connectors`.
- The Connector row never shows PROD.

## Rejected

- **`gws`, Google's Workspace CLI**: one CLI and one sign-in for all three, but the operator would still bring a Cloud project and `gcloud`, the console would need a `run_integration` allowlist, and the three could not be connected apart.
- **One "Google" Connector**: the operator asked for three standalone ones.
- **The operator brings their own client, entered in the pane** (0.1.58): four steps and a Google Cloud project before the first Connect. The other Connectors connect in one click.
- **The secret committed to git**: `AGENTS.md` bans secrets in the public repo. It is injected at release from the repo's secrets instead.
- **A read-only sign-in switch**: the Access mode already decides what the agent writes.
- **One callback port per Connector**: the one-at-a-time rule makes three ports unnecessary.

## Glossary

- **Google OAuth client**: the OAuth client Ops Console ships for Google Docs, Google Sheets and Google Drive, in the build's environment or its `google-client.json`, never in git.
- **Connector**: the list gains Google Docs, Google Sheets and Google Drive.

## ADR

- **0005 rewrite, in place**: the exception for a typed client goes. Google's client ships with the build, like Slack's client ID, and its secret comes from the repo's secrets at release. The typed client and `gws` join Considered Options, with why they lost (Rejected). No new ADR.

## Seams

- **Backend + SQLite, over HTTP** (the scripted `ConnectorTools` fake, the `claude` CLI fake, a test Google client): 1 to 4, 6 to 10, 14 to 16.
- **Backend + SQLite, over WebSocket**: 6.
- **Agent guards** (`agent-guards.test.ts`): 11, 12, 13.
- **Browser** (Playwright, the Connectors answered by the test): 5.

## Out of scope

- Google tools in Jobs and Playbooks: a later spec.
- Gmail, Calendar and other Workspace products: each would be its own Connector in a later spec.
- Showing which Google account signed in.
- An operator's own Google client.
