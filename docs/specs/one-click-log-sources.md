# One-click sign-in for the log sources

**Status:** shipped
**Design:** Integrations in `design/ops-console.html`, the "Connector signing in" panel (Jira). Departure: the Loki, New Relic and CloudWatch panes lose their typed fields. New Relic and CloudWatch keep one region choice before Connect, and every other choice is a picker the pane shows after sign-in. The OpenTelemetry pane has a Choose folder button in place of a path field.

## Problem

Connecting Loki, New Relic or CloudWatch logs asks the operator for a URL, an account ID, an API key, label names or an AWS profile name. Most operators do not know these values, and Jira, GitHub and Datadog connect with one button and a browser sign-in. [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md) already says an operator fills no form before Connect when the provider has a sign-in the console can use. Grafana Cloud, New Relic and AWS now host MCP servers with a browser sign-in, and the three log Connectors should use it.

## Behavior

1. The Loki logs, New Relic logs and CloudWatch logs panes have no typed field. Connect is always visible. A pane asks only for a choice the sign-in cannot find, and the choice sits above Connect (3, 8, 11).
2. Loki logs connects to Grafana Cloud only. Connect opens the browser at Grafana's sign-in. When it finishes, the console reads the stack's data sources through Grafana's hosted MCP server. One Loki data source is used with no question. Several show a picker with their names, and Connect finishes when the operator picks one. A stack with none says so and stays needs auth with a Reconnect.
3. New Relic logs has one choice above Connect: the Region, US, EU or JP, defaulting to US. Connect opens the browser at New Relic's sign-in through Claude Code. When it finishes, the console lists the accounts the sign-in can read. One account is used with no question, and several show a picker.
4. The label names are fixed: Loki reads `service_name` and `deployment_environment_name`, New Relic reads `service.name` and `environment`. A source whose logs have no such label or attribute reads connected, and its Scan says which name it found no Services under.
5. Disconnect on any of the three removes the Connector's sign-in the way Jira's does: the MCP server leaves Claude Code's config, and the console's own token for Loki leaves the Keychain. The Region choice and the picked account or data source stay for the next Connect.
6. New Relic's sign-in belongs to Claude Code. The daemon does not sign in to New Relic itself. Before Connect opens the browser the pane says macOS may ask for the Mac's login password once, so the console can read the sign-in Claude Code stored (Settled). The pane also says what to do when New Relic's page reports that the administrator disabled access: a New Relic administrator turns on New Relic MCP Server in Feature Control Manager, which the console cannot change.
7. A New Relic read that fails because the token expired asks Claude Code to reconnect that one server with no model turn, then reads again. When that fails too, the row reads needs auth, and the pane offers Reconnect.
8. CloudWatch logs has two choices above Connect. The Profile is a picker of the AWS profiles on this Mac, with `default` first. When no profile exists, the picker is empty and Connect creates `default` through the sign-in. The Region is a picker of AWS regions, defaulting to the profile's region when it has one.
9. CloudWatch's Connect runs the AWS CLI's browser sign-in for the picked profile, `aws login` when the profile has no SSO session, and `aws sso login` when it has one. Scans keep reading with the `aws` CLI. The agent keeps the CloudWatch MCP server. After sign-in the pane shows the log group picker as it does now.
10. An AWS CLI too old to have `aws login` stops Connect and the pane names the version and the command that updates it. The console updates nothing.
11. OpenTelemetry logs has a Choose folder button that opens the macOS folder dialog the Repos page uses. The chosen path is shown and Connect starts reading. A folder with no JSON log files connects and its Scan says no files were found.
12. Connect while a sign-in waits shows the code and link as Jira's does, with Cancel. A second Connect for the same Connector during that wait changes nothing.
13. The health check of each Connector reads through its new path. A rejected or expired sign-in reads needs auth, and an unreachable server reads down with the reason. A hosted server that answers with an unknown-tool error reads failed with that message, not needs auth.
14. A Scan of Loki or New Relic runs on the Connector's own schedule with no model turn. The daemon calls the hosted server's query tools itself: Grafana's with the console's own token, New Relic's with the sign-in read from Claude Code (6).
15. A Scan keeps its steps: list the Services, count failing events per 10-minute bucket by status, method and route, read the newest failing events as Samples, at most 5,000 per Service, and say so when the cap is hit. Severity, Fingerprint, thresholds and redaction do not change.
16. A tool answer the console cannot read, a result cut by the server's own row limit, and an error the server returns fail that source with `upstream_failed` and the server's words. A rate limit fails it with `rate_limited` when the answer names one. Another source's Scan still runs.
17. The agent reaches Loki and New Relic logs through the MCP server Connect registered with Claude Code, as it reaches Jira. `logcli` and `newrelic` leave the `run_integration` allowlist, and the console runs neither. The agent's brief for a Loki or New Relic Alert names the MCP server instead of the CLI. The agent may call only the hosted servers' read tools, as CloudWatch's allowlist does for its server: Grafana's data source, label and Loki query tools, and New Relic's NRQL and account tools. Any other tool of those servers is refused with a reason. `aws` was never on the allowlist and stays off it.
18. After the update, a connected Loki or New Relic row reads needs auth with Reconnect, and its Services, Alerts, Scans and schedules stay. A connected CloudWatch row keeps its profile and region, and keeps working with no new sign-in when its profile is still signed in. A connected OpenTelemetry row is unchanged. The first start deletes the old Keychain key `connection:loki_logs`, and a start with it absent does nothing. `connection:new_relic_logs` is the key of the key route (24) and stays.
19. A Loki Connector that held a self-hosted URL reads needs auth with the detail "Loki on Grafana Cloud only: the self-hosted URL is no longer read." Its history stays and Reconnect connects Grafana Cloud.
20. Five sources at once, a reload mid-sign-in, two Sessions at once and an agent that fails mid-run behave as before.
21. A PROD env is read-only like any other. The console and the agent write nothing to Loki, New Relic or CloudWatch.
23. New Relic logs has a second way to connect, for an organization whose administrator turned off New Relic's MCP server in Feature Control Manager. Under Connect, a quiet link "Use a User API key instead" opens one password field for the key, next to the same Region choice, and a Connect with key button. The pane says once what the key needs: a User API key with read access to the account's logs. The key is never shown again.
24. Connecting with a key checks it by listing the accounts it can read. A key New Relic refuses (401 or 403) is not stored and the pane shows why, with the Connector as it was. A good key goes to the Keychain as `connection:new_relic_logs`, and then 3 applies: one account is used, several show the picker.
25. One route is active at a time. A connected key replaces the MCP sign-in and removes New Relic's server from Claude Code's config. A connected MCP sign-in replaces the key and deletes it from the Keychain. A route that fails to connect leaves the other as it was. Disconnect clears both, and the Region and picked account stay.
26. With a key, the Scan, the Recheck and the health check call New Relic's regular API (NerdGraph) from the daemon, with the same queries as the MCP route, the same 5,000 Sample cap and the same 61-hour limit on counts (15). A 401 or 403 reads needs auth, a 429 fails with `rate_limited`, any other failure with `upstream_failed` and New Relic's words. No error, log, response or page holds the key.
27. With a key, the agent has no New Relic MCP server. A Verification, a Fix or a chat on a New Relic Alert gets the console's own tool `query_new_relic` in the `ops-console` server. It takes NRQL text only, runs one read-only query for the picked account with the key the daemon holds, refuses anything but a `SELECT`, `FROM` or `SHOW` query, returns at most 200 rows, and runs with no Approval, as a row in the Action Log. The agent's brief names the tool in place of New Relic's MCP server.
22. Docs: the Connectors page replaces the Loki, New Relic and CloudWatch field lists with the sign-in steps, the one Region choice for New Relic, the profile and region pickers for CloudWatch, the Choose folder button, and the Grafana Cloud-only note. The data-flow page says the daemon holds a Grafana token in the Keychain, reads New Relic's sign-in from Claude Code's, and calls the hosted servers' tools. Both pages also say the key route calls New Relic's API with a key in the Keychain, and that the agent reaches New Relic through the console's own tool then (23 to 27).

## Settled

- **Connector ids**: unchanged: `loki_logs`, `new_relic_logs`, `cloudwatch_logs`, `otel_logs`. Names and `via` strings change: "Loki logs" via Grafana Cloud MCP, "New Relic logs" via New Relic MCP, "CloudWatch logs" via aws CLI + CloudWatch MCP.
- **Grafana sign-in**: the daemon signs in itself with the MCP SDK's OAuth client, which registers on the fly. The browser comes back to a loopback callback on the daemon, so [ADR 0003](../adr/0003-local-only-server.md) holds. The tokens live in the Keychain under `connection:loki_logs_oauth`, per [ADR 0004](../adr/0004-secrets-in-keychain.md). Connect also registers Grafana's server with Claude Code for the agent, which can open one more browser sign-in, usually one click.
- **New Relic sign-in**: Claude Code's MCP sign-in only. New Relic's server uses a client registered for known MCP hosts, so the console cannot sign in itself. The daemon reads the access token Claude Code stored for that server, and never refreshes it (7), so two refreshers cannot invalidate each other.
- **Why not a model turn for Scans**: each Scan would spend tokens and read the logs differently each time.
- **New Relic key route**: the operator's User API key and New Relic's regular API (NerdGraph), a direct HTTP client in the daemon that [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md) now allows for this case. The Region picks the host: `https://api.newrelic.com/graphql` for US, `api.eu.newrelic.com` for EU and `api.jp.newrelic.com` for JP, called over HTTPS with the key in the `API-Key` header and with redirects refused. The Region comes from the enum, never from free input. The key is `connection:new_relic_logs` in the Keychain ([ADR 0004](../adr/0004-secrets-in-keychain.md)), read at each call. The route is `route: mcp | key` in the Connector's config, which holds no secret. Queries go as GraphQL variables, `actor.accounts` lists accounts and `actor.account(id) { nrql(query:, timeout:) { results } }` runs NRQL, so the Scan's NRQL is built once and runs on either route.
- **Region of New Relic**: the one value the sign-in cannot find. It picks the server address: `mcp.newrelic.com` for US, and the EU and JP addresses New Relic documents. Which address serves which region is unconfirmed. `/ship` checks it in New Relic's documentation.
- **Account and data source pickers**: shown after sign-in, from the server's own lists. They are stored in the Connector's config.
- **Config**: Loki keeps `datasource_uid`, New Relic keeps `region` and `account_id`, CloudWatch keeps `profile`, `region` and `log_groups`, OpenTelemetry keeps `folder`. Every other typed field leaves the config: Loki's `url`, `org_id`, `auth`, `username`, `selector` and `format`, New Relic's attribute names and `filter`. The fields every log source has stay.
- **Logs per call**: the 5,000 cap per Service holds. The hosted servers' own row limits per tool call are unconfirmed, so a Scan of Loki pages by time until the cap or the end, and reads a page as full when it holds as many lines as asked for. A Scan of New Relic makes one query with `LIMIT 5000`, NRQL's own maximum. A server that refuses to page, or a result cut at its own limit, fails with `upstream_failed`.
- **Unconfirmed for the key route**: New Relic's documentation shows the endpoints, the `API-Key` header, `actor.accounts { id name }` and the `nrql(query:) { results }` shape, and says a limited request answers 429 (25 concurrent requests per user). It does not say whether Feature Control Manager reaches NerdGraph (its pages scope the switches to the MCP server), what body a refused key gets, the type names of the query variables (`Int!`, `Nrql!`), whether `timeout:` is accepted on `account.nrql` and in which unit, or how FACET rows name their values. The client treats 401 and 403 as a refused key, any GraphQL `errors` entry as a failure with its message, and the Scan reader already reads FACET rows either way.
- **Unconfirmed**: the hosted servers' tool names, argument names and answer shapes, how a New Relic server answers an expired token, and the name and fields of Claude Code's stored sign-in item. `/ship` reads each server's documentation and a real Claude Code install, and the tests use scripted fakes.
- **Error codes**: no new code. A missing AWS CLI uses `tool_missing`.

## Not required

- **Self-hosted Loki.** It has no OAuth path. A Grafana service-account token or a proxy login belongs to a later spec if operators ask.
- **Editing label names, the selector, the format or the New Relic filter.** The names are fixed (4). A different label reads as a source with no Services.
- **More than one stack, account or data source per Connector.** A second one is a second Connector in a later spec.
- **Fixing a New Relic sign-in Claude Code has lost.** The row reads needs auth and the operator reconnects.

## Safety

The agent's reach changes: `logcli` and `newrelic` leave `run_integration`, and Loki and New Relic logs come through MCP servers registered with Claude Code, which the agent calls through Claude Code. The agent still reads logs and writes nothing. The console sends no write tool call to any of the three servers. The daemon now holds a Grafana token in the Keychain, and reads one Claude Code item for New Relic, held only in memory for the call and never written to the database, a log, a response or the browser. The first read of that item shows a macOS prompt the operator can refuse, and a refusal reads needs auth. PROD is read-only.

The key route adds a secret and a client. The daemon holds the operator's User API key in the Keychain and calls New Relic's API with it, to the documented host for the Region and no other. The key never reaches the database, a log, an error, a response, a WebSocket payload, the page or the agent. The agent's reach is the one read-only tool in 27: NRQL text for the one picked account, SELECT, FROM and SHOW only, 200 rows, with an Action Log row before it runs. NRQL has no write verb, and the tool offers no other GraphQL. A User key reaches every account its user can open, and the console queries only the picked one, so the docs advise a read-only user. PROD is read-only.

## Database

No table changes. The New Relic Connector's config gains `route` (`mcp` or `key`, default `mcp`), read with that default from a row stored without it. One migration, `0047_one_click_log_sources.sql`, rewrites the `connectors.config` JSON of the Loki and New Relic rows and sets a connected row to `auth`.

```sql
UPDATE connectors
SET status_detail = CASE
      WHEN coalesce(json_extract(config, '$.url'), '') = '' OR json_extract(config, '$.url') GLOB 'https://*.grafana.net*'
        THEN 'Sign in again to use Grafana Cloud.'
      ELSE 'Loki on Grafana Cloud only: the self-hosted URL is no longer read.'
    END,
    status = 'auth',
    account_label = NULL
WHERE id = 'loki_logs' AND status <> 'off';

UPDATE connectors
SET config = json_set(json_remove(config, '$.url', '$.org_id', '$.auth', '$.username', '$.service_label', '$.env_label', '$.selector', '$.format'), '$.datasource_uid', '')
WHERE id = 'loki_logs';

UPDATE connectors
SET status = 'auth', status_detail = 'Sign in again to use the New Relic MCP server.', account_label = NULL
WHERE id = 'new_relic_logs' AND status <> 'off';

UPDATE connectors
SET config = json_remove(config, '$.service_attribute', '$.env_attribute', '$.filter')
WHERE id = 'new_relic_logs';
```

A connected row reads needs auth with its detail and no account label, so Reconnect shows. A row that is off keeps its status and gets the same config cleanup, because the strict config schema rejects the removed keys. The Loki row's `datasource_uid` starts empty. The Keychain keys are deleted by the daemon at start, not by SQL.

## API

### Common

`POST /connectors/:id/connect` keeps its 202 and the Connector's `sign_in` field. The shared connect body shrinks to what each Connector needs above Connect.

```json
{ "region": "US|EU|JP",
  "account_id": "optional",
  "datasource_uid": "optional",
  "profile": "optional",
  "log_groups": [],
  "folder": "optional",
  "api_key": "optional" }
```

`api_key` is New Relic's User API key (23, 24). It is read once, checked against New Relic, stored in the Keychain and never returned: no response, event or list carries it. The Connector's `config.route` says which sign-in is read, and `via` reads "New Relic API" with a key.

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `invalid_state` | the AWS CLI is too old for `aws login` |
| 409 | `pick_required` | several accounts or data sources and none picked |
| 422 | `tool_missing` | `aws` or `uvx` is not installed for CloudWatch |
| 422 | `validation_failed` | a field is not in the allowed set for that Connector, or New Relic refused the key |
| 429 | `rate_limited` | New Relic throttled the key check |
| 502 | `upstream_failed` | New Relic did not answer, or answered with an error |

### `GET /connectors/loki_logs/datasources` and `GET /connectors/new_relic_logs/accounts`

Lists for the pickers, `{ "data": [{ "id": "...", "name": "..." }], "meta": { "next_cursor": null } }`. Both need a signed-in Connector and return 409 `invalid_state` otherwise.

### `POST /connectors/otel_logs/pick-folder`

Opens the macOS folder dialog and returns `{ "data": { "path": "/Users/you/otel-logs" | null } }`. `null` means the operator cancelled.

### `GET /connectors/cloudwatch_logs/profiles`

The AWS profiles on this Mac, `{ "data": [{ "name": "...", "region": "us-east-1" | null }], "meta": { "next_cursor": null } }`.

## UI

- **Integrations**: the Loki, New Relic, CloudWatch and OpenTelemetry panes follow the Jira pane: one step, Connect, Reconnect, Disconnect, Cancel while waiting, and the sign-in code and link. Choices above Connect sit in a card above the button. Pickers after sign-in sit under the step. States: not connected, signing in, needs auth with the reason, connected with the account, data source or log groups shown, down with the reason, checking. The panes lose every field the Behavior removes. It departs from the design's Jira pane by the region, profile and folder choices.
- **Monitor** and **Report**: no change.
- The pane tells the operator about the macOS prompt for New Relic (6).
- The New Relic pane has "Use a User API key instead" under the one-click step, closed at first. Open, it shows one password field (API key), says once what the key needs, and has Connect with key. It closes when the key is sent and opens empty. The pane reads "with your User API key" when that route is connected, and Disconnect names the Keychain key it removes.

## Rejected

- **The daemon signs in to New Relic or AWS itself**: New Relic's server uses a fixed client, and AWS lets only approved agents register, so the console would be refused.
- **A model turn for each Scan**: costs tokens and the reading varies run to run.
- **Keep the typed form behind an Advanced link**: you chose one way to connect.
- **No New Relic API key** (the first version's choice: the key path left with the form): an organization whose administrator turned off the MCP server cannot connect at all, and only that administrator can change it. The key route returns as a second way to connect, quiet under the one-click Connect, so every other operator still connects with no typed field.
- **Keep `logcli` and the `newrelic` CLI for Scans**: needs an install and a key, which is the setup this change removes.
- **The AWS MCP Server for CloudWatch**: the daemon cannot read its sign-in without the model, and the `aws` CLI sign-in already works.

## Glossary

- **Daemon sign-in**: a sign-in the console performs itself, with its own client, and keeps in the Keychain. Grafana Cloud uses one. Every other MCP sign-in belongs to Claude Code.
- **Loki data source**: one Loki in a Grafana stack that the Loki logs Connector reads. The operator picks it when the stack has several.
- **Log source**: update the line to say Loki means Grafana Cloud's Loki.

## ADR

- **Amend [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md)**: the console may hold an MCP sign-in of its own (Grafana Cloud's) when the server lets any client register, and may read the sign-in Claude Code stored for a server (New Relic's) when the server will not. Trade-off: the second depends on Claude Code's private storage and a macOS prompt, and the alternative, a model turn for each Scan, costs tokens and varies.
- **Amend [ADR 0004](../adr/0004-secrets-in-keychain.md)**: add the key `connection:loki_logs_oauth`, remove `connection:loki_logs`, and say the daemon reads Claude Code's item for New Relic. `connection:new_relic_logs` returns as the New Relic User API key of the key route, so the first start no longer deletes it.
- **Amend ADR 0005 again**: the console may call New Relic's API directly with a User API key for an organization that turned off New Relic's MCP server. Trade-off: a second client and a pasted secret against a Connector that cannot connect at all.
- **Amend [ADR 0009](../adr/0009-opentelemetry-logs-are-read-from-a-folder.md)**: the folder is chosen with the folder dialog.

## Seams

- **Backend + SQLite, `connectors.test.ts`** (fakes for `aws`, the Grafana sign-in, Claude Code's stored sign-in, the folder dialog and New Relic's API): 1 to 3, 5 to 12, 18, 19, 21, 23 to 26.
- **Backend + SQLite, `monitor.test.ts`** (scripted MCP servers for Grafana and New Relic, and a scripted New Relic API): 4, 7, 13 to 16, 20, 26, 27.
- **Unit, `agent-guards.test.ts`**: 17.
- **Backend + SQLite, `store.test.ts`**: the migration, 18 and 19.
- **Frontend, one e2e spec per Connector pane**: 1 to 3, 8, 11, 12, 18, 19, 23, and the pane states in UI.
- **Docs, `site/build.test.mjs`**: 22.

## Out of scope

- Self-hosted Loki and a service-account token path, in a later spec if asked.
- A second stack, account or data source per Connector.
- The Playbook Verify step's "Datadog logs" wording for non-Datadog Alerts, already noted in the New Relic spec.
