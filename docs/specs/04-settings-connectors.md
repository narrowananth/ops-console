# Settings: Connectors

**Status:** shipped
**Design:** Settings › Connectors and the Connector drawer (fields, Test, Save changes, Disconnect)

## Problem

Monitor needs Datadog to scan, the fix flow needs Jira and a Git host, and review requests go to Slack. The operator has to sign in to each service, set what the console uses it for, and see at a glance which ones work. Without a Connector the feature that depends on it fails halfway instead of saying what to connect.

## Behavior

1. Listing Connectors returns all seven in a fixed order, each with how it is reached (`via`), status, account label and config. The first start seeds every Connector with status `off`.
2. Connecting a Connector that rides an MCP Server (Jira, Slack, Sentry) registers that server in every account if it is missing (`03-settings-mcp-servers`), then runs its Authenticate. The Connector's status follows the server's.
3. Connecting Datadog or GitHub runs the CLI's own browser sign-in (`pup auth login`, `gh auth login --web`). Connecting Datadog also registers the `datadog-pup` MCP Server (`pup mcp serve`) so the agent can query it, when the installed `pup` has an `mcp` command; `pup` 2.3.5 has none, and then nothing is registered.
4. Connecting GitLab or Bitbucket takes a token as `secret`. It goes to the Keychain adapter under `connector:<id>`. GitLab then signs `glab` in with it, reading the token from stdin. Bitbucket uses it for API calls, and git uses the operator's SSH key.
5. After a sign-in, the console runs a check. A check records status, account label and, for a Git host, the signed-in `login`. `07-workspace` uses `login` to tell the operator's own pull requests apart.
6. A sign-in that fails or is cancelled leaves the status `auth` with the reason in `status_detail`.
7. Saving config validates it per Connector. A bad value (a Datadog threshold that is not a number, a scan time that is not `HH:MM`) returns `validation_failed` naming the fields and saves nothing. Blank fields keep their value.
8. Disconnect clears what the console stored and sets the Connector `off`:
   - For an MCP-backed Connector it removes the server (`03-settings-mcp-servers` Behavior 12).
   - For GitLab and Bitbucket it deletes the Keychain token.
   - It clears `login`.
9. Disconnect does not sign `pup`, `gh` or `glab` out. The operator's own terminal shares that login. The console stops calling the CLI for this Connector.
10. An action that needs a Connector whose status is not `ok` is refused with `connector_not_connected`, naming the Connector. Nothing is started.
11. Reading the list checks again, in the background, every connected Connector whose last check is older than 10 minutes.
12. Every check and sign-in sends `connection.checked` with target `connector`.
13. No response, event or log carries a token. Reads show `secret_stored`.

## Settled

- **Connectors and how each is reached** (ADR 0005: through a tool Claude also uses):

  | Connector | Via | Sign-in |
  | --------- | --- | ------- |
  | `datadog` | `pup` CLI, and the `datadog-pup` MCP Server | OAuth through `pup` |
  | `jira` | Atlassian MCP Server | OAuth through Claude Code |
  | `slack` | Slack MCP Server | OAuth through Claude Code |
  | `sentry` | Sentry MCP Server | OAuth through Claude Code |
  | `github` | `gh` CLI | OAuth through `gh` |
  | `gitlab` | `glab` CLI | token |
  | `bitbucket` | git over SSH, plus the Bitbucket API | token |

- **Fixed reads**: the console calls `pup`, `gh`, `glab` and the Bitbucket API directly for checks, Scans and pull request lists, with no model turn. Ticket and message work runs in agent sessions through the MCP Servers.
- **Order**: Datadog, Jira, GitHub, GitLab, Bitbucket, Slack, Sentry.
- **Sentry**: kept as a Connector, as the architecture doc says, though the design shows "No Sentry connector yet".
- **Reports folder**: defaults to `reports` inside the data directory (`01-base-daemon-setup`), not the design's `~/.ops-console/reports`.
- **Check**: a check reads the CLI or API for a signed-in user (`pup auth status`, `gh api user`, `glab api user`, the Bitbucket user endpoint) or, for an MCP-backed Connector, a new Probe of its server. A tool that fails to answer reads `fail`; a tool that is signed out reads `auth`.
- **GitHub sign-in**: `gh auth login --web --git-protocol ssh --clipboard`; the one-time code lands on the clipboard because no terminal is attached.
- **MCP servers**: Jira is `atlassian` (sse), Slack is `slack` (http), Sentry is `sentry` (http), Datadog is `datadog-pup`. `03-settings-mcp-servers` shows the Connector in `used_by`.
- **Design departure**: secrets go to the Keychain, not `~/.ops-console/secrets` (ADR 0004).

## Not required

- **Live status**: a status can be 10 minutes old until the list is read again.
- **CLI sign-out**: after Disconnect, `pup`, `gh` and `glab` stay signed in for the operator's own terminal.

## Safety

No change to the agent's reach. The agent cannot change a Connector's config or connect one. The setup agent in `05-settings-dev-tools` can start a sign-in through the same code as the endpoint, and the operator completes it in the browser. Tokens go only to the Keychain adapter.

## Database

```sql
CREATE TABLE connectors (
  id               TEXT PRIMARY KEY NOT NULL,      -- ConnectorId
  status           TEXT NOT NULL DEFAULT 'off',    -- HealthStatus
  status_detail    TEXT,
  account_label    TEXT,                           -- site, workspace or org shown in the list
  login            TEXT,                           -- signed-in user on a Git host
  config           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),  -- never a secret
  last_checked_at  TEXT
) STRICT;
```

Enums live in code only (`01-base-daemon-setup`):

| Enum | Values | Used by |
| ---- | ------ | ------- |
| `ConnectorId` | `datadog`, `jira`, `github`, `gitlab`, `bitbucket`, `slack`, `sentry` | `connectors.id` |
| `HealthStatus` | from `03-settings-mcp-servers` | `connectors.status` |

Migration of existing rows: none. The migration creates the table and inserts one row per `ConnectorId` with status `off` and that Connector's default config.

## API

### Common

Envelopes, auth and shared error codes come from `01-base-daemon-setup`. This spec adds one code:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `connector_not_connected` | The action needs a Connector whose status is not `ok`; `message` names it |

`Connector`: all `connectors` columns, plus `name`, `via` and `secret_stored`.

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /connectors` | | `Connector[]` in the fixed order |
| `PATCH /connectors/:id` | `{ config }` | `Connector`; `validation_failed` with field names |
| `POST /connectors/:id/connect` | `{ secret? }` | 202; `secret` required for GitLab and Bitbucket. `connection.checked` reports the result |
| `POST /connectors/:id/checks` | | `{ status, status_detail, account_label, login, last_checked_at }` |
| `DELETE /connectors/:id/credentials` | | `Connector` with `status: off`, `login: null` (Disconnect) |

Config shapes:

```json
{
  "datadog": {
    "site": "string",
    "environments": ["string"],
    "daily_scan_time": "HH:MM",
    "default_interval": "24h | 12h | 6h",
    "rapid_errors_per_10m": 100,
    "failing_errors_per_hour": 5,
    "ignore": [{ "kind": "status_class | route", "value": "string" }],
    "reports_folder": "string"
  },
  "jira": {
    "site": "string",
    "project_key": "string",
    "issue_types": { "bug": "string", "improvement": "string" },
    "in_review_status": "string",
    "create_tickets": true
  },
  "github": { "org": "string | null" },
  "gitlab": { "host": "string" },
  "bitbucket": { "workspace": "string", "ssh_key_path": "string", "pr_target_branch": "string" },
  "slack": { "workspace": "string", "alert_channel": "string", "review_dm_to": "string" },
  "sentry": { "org": "string | null" }
}
```

`connection.checked` (target `connector`) is defined in `03-settings-mcp-servers`.

## UI

Settings › Connectors, as designed: one row per Connector with name, status, `via` and account label. The drawer shows the fields for that Connector, with each current value as the placeholder ("Leave a field blank to keep its current value"), Test, Save changes and Disconnect with a confirm ("Signs out and stops Claude from using it. Monitor and tasks that rely on it pause").

- Loading: rows from the table at once; statuses refresh as checks return.
- Not connected: the drawer's main action is Connect.
- Error: `status_detail` under the status, with Connect again.

## Rejected

- **API clients written into the console for each service**: ADR 0005. Claude already reaches them through MCP Servers and CLIs, and the console reuses those.
- **Signing the CLIs out on Disconnect**: it would also sign the operator's own terminal out.

## Seams

- **Backend + SQLite, over HTTP** (fakes for `pup`, `gh`, `glab`, the Bitbucket API, the `03-settings-mcp-servers` endpoints and the Keychain adapter): 1 to 11, 13.
- **Backend + SQLite, over WebSocket**: 12.

## Out of scope

- What Monitor does with Datadog and Jira: `08-monitor-dashboard`.
- Pull request lists and `is_mine`: `07-workspace`.
- Slack alert ingestion: a later spec.
