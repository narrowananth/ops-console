# Settings: Connectors

**Status:** shipped
**Design:** the design's Connectors tab, merged with MCP servers into Settings › Integrations, and the Connector drawer (a numbered sign-in step like claude.ai's, and Disconnect)

## Problem

Monitor needs Datadog to scan, the fix flow needs Jira and a Git host, and review requests go to Slack. The operator has to sign in to each service, set what the console uses it for, and see at a glance which ones work. Without a Connector the feature that depends on it fails halfway instead of saying what to connect. Signing in has to work the way claude.ai and ChatGPT do it: Connect opens the provider's sign-in page and the operator types nothing in the console.

## Behavior

1. Listing Connectors returns all eight in a fixed order, each with how it is reached (`via`), status, account label and config. The first start seeds every Connector with status `off`.
2. Connect takes no body. It starts the provider's own browser sign-in and answers 202 at once. Nothing is typed in the console before Connect.
3. Connecting a Connector that rides an MCP Server (Jira, Bitbucket, Slack, Sentry, Shopify) registers that server in every account if it is missing (`03-settings-mcp-servers`), then runs its Authenticate; Shopify's Dev MCP needs no sign-in. Jira and Bitbucket share the `atlassian` server. The Connector's status follows the server's.
4. Connecting Datadog, GitHub or GitLab runs the CLI's own browser sign-in (`pup auth login`, `gh auth login --web`, `glab auth login --web`). Connecting GitHub first installs `gh` and `github-mcp-server` from Homebrew when they are not on the PATH, and is refused with "install Homebrew from brew.sh" when Homebrew is missing too. After the sign-in it registers the `github` MCP Server (`github-mcp-server stdio`) with the `gh` token (`gh auth token`) as `GITHUB_PERSONAL_ACCESS_TOKEN`, kept in the Keychain and passed through the launcher, so it never reaches Claude Code's config. Connecting Datadog also registers the `datadog-pup` MCP Server (`pup mcp serve`) so the agent can query it, when the installed `pup` has an `mcp` command; `pup` 2.3.5 has none, and then nothing is registered. Connecting GitLab installs `glab` the same way, and skips the sign-in when `glab` is already signed in to the host, because `glab` asks to confirm a second sign-in.
5. While a sign-in waits on the operator, the Connector's `sign_in` holds the page the CLI printed and, for GitHub, the one-time code (`gh` prints the page instead of opening it when no terminal is attached). Each change sends `connection.checked`; `sign_in` is `null` once the sign-in ends.
6. After a sign-in, the console runs a check. A check records status, account label and, for a Git host, the signed-in `login`. `07-workspace` uses `login` to tell the operator's own pull requests apart.
7. A sign-in that fails or is cancelled leaves the status `auth` with the reason in `status_detail`.
8. Saving config validates it per Connector. A bad value (a Datadog threshold that is not a number, a scan time that is not `HH:MM`) returns `validation_failed` naming the fields and saves nothing. Blank fields keep their value.
9. Disconnect clears what the console stored and sets the Connector `off`:
   - For an MCP-backed Connector it removes the server (`03-settings-mcp-servers` Behavior 12), unless another connected Connector rides it.
   - It clears `login`.
10. Disconnect does not sign `pup`, `gh` or `glab` out. The operator's own terminal shares that login. The console stops calling the CLI for this Connector.
11. An action that needs a Connector whose status is not `ok` is refused with `connector_not_connected`, naming the Connector. Nothing is started.
12. Reading the list checks again, in the background, every connected Connector whose last check is older than 10 minutes.
13. Every check and sign-in sends `connection.checked` with target `connector`.
14. No response, event or log carries a token.

## Settled

- **Connectors and how each is reached** (ADR 0005: through a tool Claude also uses):

  | Connector | Via | Sign-in |
  | --------- | --- | ------- |
  | `datadog` | `pup` CLI, and the `datadog-pup` MCP Server | OAuth through `pup` |
  | `jira` | Atlassian MCP Server | OAuth through Claude Code |
  | `slack` | Slack MCP Server | OAuth through Claude Code |
  | `sentry` | Sentry MCP Server | OAuth through Claude Code |
  | `github` | `gh` CLI, and the `github` MCP Server | OAuth through `gh` |
  | `gitlab` | `glab` CLI | OAuth through `glab` |
  | `bitbucket` | Atlassian MCP Server; git over SSH | OAuth through Claude Code |
  | `shopify` | Shopify Dev MCP Server (`npx -y @shopify/dev-mcp@latest`) | none |

- **Fixed reads**: the console calls `pup`, `gh` and `glab` directly for checks, Scans and pull request lists, with no model turn. Bitbucket has none: its OAuth token stays with Claude Code (ADR 0005). Ticket and message work runs in agent sessions through the MCP Servers.
- **Order**: Datadog, Jira, GitHub, GitLab, Bitbucket, Slack, Sentry, Shopify.
- **Sentry**: kept as a Connector, as the architecture doc says, though the design shows "No Sentry connector yet".
- **Reports folder**: defaults to `reports` inside the data directory (`01-base-daemon-setup`), not the design's `~/.ops-console/reports`.
- **Check**: a check reads the CLI for a signed-in user (`pup auth status`, `gh api user`, `glab api user`) or, for an MCP-backed Connector, a new Probe of its server. A tool that fails to answer reads `fail`; a tool that is signed out reads `auth`.
- **GitHub sign-in**: `gh auth login --web --git-protocol ssh --clipboard`. With no terminal attached `gh` copies the one-time code and prints `https://github.com/login/device` without opening it; the drawer shows both. GitHub's own OAuth would need a registered app secret, which this public repo cannot ship.
- **GitLab sign-in**: `glab auth login --hostname <host> --web --git-protocol ssh --container-registry-domains <host>,<host>:443,registry.<host>`; the flags answer every prompt but the browser step.
- **MCP servers**: Jira and Bitbucket share `atlassian` (http), Slack is `slack` (http), Sentry is `sentry` (http), Datadog is `datadog-pup`, GitHub is `github` (stdio), Shopify is `shopify` (stdio). `03-settings-mcp-servers` shows the Connector in `used_by`.
- **Design departure**: secrets go to the Keychain, not `~/.ops-console/secrets` (ADR 0004). The drawer has no token field, config fields or Test.

## Not required

- **Live status**: a status can be 10 minutes old until the list is read again.
- **Editing config in the UI**: settings such as the Jira project or Slack channel keep their defaults; only the API changes them.
- **CLI sign-out**: after Disconnect, `pup`, `gh` and `glab` stay signed in for the operator's own terminal.

## Safety

No change to the agent's reach. The agent cannot change a Connector's config or connect one. The setup agent in `05-settings-dev-tools` can start a sign-in through the same code as the endpoint, and the operator completes it in the browser. The console holds no Connector token; the `gh` token for the `github` MCP Server goes only to the Keychain adapter.

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
| `ConnectorId` | `datadog`, `jira`, `github`, `gitlab`, `bitbucket`, `slack`, `sentry`, `shopify` | `connectors.id` |
| `HealthStatus` | from `03-settings-mcp-servers` | `connectors.status` |

Migration of existing rows: none. The migration creates the table and inserts one row per `ConnectorId` with status `off` and that Connector's default config.

## API

### Common

Envelopes, auth and shared error codes come from `01-base-daemon-setup`. This spec adds one code:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `connector_not_connected` | The action needs a Connector whose status is not `ok`; `message` names it |

`Connector`: all `connectors` columns, plus `name`, `via` and `sign_in` (`{ code, url }` while a sign-in waits on the operator, else `null`).

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /connectors` | | `Connector[]` in the fixed order |
| `PATCH /connectors/:id` | `{ config }` | `Connector`; `validation_failed` with field names |
| `POST /connectors/:id/connect` | | 202. `connection.checked` reports `sign_in` changes and the result |
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
  "sentry": { "org": "string | null" },
  "shopify": {}
}
```

`connection.checked` (target `connector`) is defined in `03-settings-mcp-servers`.

## UI

Settings › Integrations, first in the list: one row per Connector with name, a `Connector` label, status (`◌ signing in` while `sign_in` is set), `via` and account label. The drawer reads "Connect <name> to Ops Console" over one numbered step, "1 Sign in to <name>", with Connect on the right ("Opens <name>'s sign-in page in your browser. Nothing to fill in here."). While the sign-in waits, the step says to finish in the browser, shows GitHub's code ("Enter this code (already copied)") and an Open <name> ↗ link to the page. Once connected, the step reads "Signed in as <login>" with Reconnect, and Disconnect with a confirm ("Signs out and stops Claude from using it. Monitor and tasks that rely on it pause") follows. The drawer has only Connect, Reconnect and Disconnect: no config fields and no Test. Config keeps its defaults unless set through `PATCH /connectors/:id`.

- Loading: rows from the table at once; statuses refresh as checks return.
- Not connected: the step's action is Connect.
- Error: `status_detail` in the step, with Reconnect.

## Rejected

- **API clients written into the console for each service**: ADR 0005. Claude already reaches them through MCP Servers and CLIs, and the console reuses those.
- **Signing the CLIs out on Disconnect**: it would also sign the operator's own terminal out.
- **Token fields for GitLab and Bitbucket**: the operator had to make and paste a token. `glab --web` and Atlassian's OAuth sign in without one (ADR 0005).

## Seams

- **Backend + SQLite, over HTTP** (fakes for `pup`, `gh`, `glab`, the `03-settings-mcp-servers` endpoints and the Keychain adapter): 1 to 12, 14.
- **Backend + SQLite, over WebSocket**: 5, 13.

## Out of scope

- What Monitor does with Datadog and Jira: `08-monitor-dashboard`.
- Pull request lists and `is_mine`: `07-workspace`.
- Slack alert ingestion: a later spec.
