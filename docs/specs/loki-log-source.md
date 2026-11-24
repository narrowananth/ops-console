# Grafana Loki logs as a fourth log source

**Status:** shipped; the connection and reach (items 1 to 6, 15, 19 to 21) follow [one-click-log-sources](one-click-log-sources.md)
**Design:** Monitor and Integrations in `design/ops-console.html`. Departure: Integrations lists a fifteenth Connector whose pane has no typed field, only a Connect button and, after the sign-in, a data source picker, and Alerts and Services carry a source label.

## Problem

A team whose logs are in Grafana Loki cannot use Monitor through Datadog, the OpenTelemetry Log folder or CloudWatch logs. Grafana Cloud hosts an MCP server with a browser sign-in, so the operator types no URL, token or label name ([ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md)). The daemon reads logs by calling that server's query tools with the console's own sign-in and no model turn, and the agent reads more logs through the same server during a Verification.

## Behavior

1. Integrations lists a fifteenth Connector, Loki logs, after CloudWatch logs in the fixed order. Its pane has no typed field and Connect is always visible. Connect opens Grafana Cloud's sign-in in the browser. When the stack has one Loki data source it is used. When it has several, the pane shows a picker with their names, and Connect finishes when the operator picks one. A stack with none says so and stays needs auth with Reconnect.
2. The label names are fixed: `service_name` for the Service and `deployment_environment_name` for the env. The format is JSON. Nothing about them is configurable.
3. The console signs in to Grafana itself with the MCP SDK's OAuth client, and the tokens go to the Keychain under `connection:loki_logs_oauth`. They never reach the database, the logs, an API response, a WebSocket payload or the browser. Disconnect removes them.
4. Connect needs no CLI. The console installs nothing.
5. The health check lists the stack's Loki data sources through Grafana's server. Signed in and the picked data source present reads connected, with the data source's name. A missing or refused sign-in reads needs auth with "Sign in again to use Grafana Cloud.", and a stack that signs in with no data source picked reads needs auth with "Choose a Loki data source to finish connecting." A picked data source the stack no longer has reads down, and an unreachable server reads down with the reason. A server error reads down with its words.
6. Connecting registers Grafana's MCP server (`grafana`) with Claude Code for the agent. Claude Code can open one more browser sign-in for it, usually one click, and the Connector reads connected without it.
7. A Scan reads every connected log source. A Scan the operator starts for one source reads only that source. Loki logs runs on its own schedule from its own Check interval and daily scan time.
8. A Scan finds the Services from the values of `service_name` over the Scan's window. A stream with a `deployment_environment_name` reads as that env, and one without reads as `no env`. The Service is named by the label value. When no stream has the `service_name` label, the Scan says so in its notes.
9. The reader expects JSON lines. Each field takes the first of these names present after parsing, with nested keys joined by `_`. Status code: `status`, `statusCode`, `status_code`, `http_status_code`. Method: `method`, `httpMethod`, `http_method`. Route: `route`, `path`, `resourcePath`, `url_path`. Level: `level`, `severity`, `log_level`. Message: `message`, `msg`. Time: the time Loki stores for the line. A line that does not parse has none of these and is not read as a failure.
10. A line counts as failing when its status code is 400 or more, or its level is `error`, `critical`, `alert`, `emergency` or `fatal`, in any case.
11. A first query counts failing lines per 10-minute bucket for each Service, grouped by status code, method and route. A second query reads the newest failing lines of each Service as Samples, at most 5,000 per Service. Grafana's server returns 100 lines a call, so the Scan pages back through the window until it has 5,000 lines or reaches the start. The Scan groups them into Alerts by route, status code and masked message.
12. The Scan groups failing lines into Alerts with the same Severity rules, thresholds and Fingerprint masking as for the other sources. The Fingerprint of a Loki Alert includes the source. Datadog Fingerprints do not change.
13. When a Service has more than 5,000 failing lines in the window, a Route with one message group takes its count and 10-minute peak from the full metric query, and a Route with several message groups counts the newest 5,000 lines read. The Scan's notes say so for that Service.
14. Each Sample keeps its message and fields with secret values and request body values redacted, as a Datadog Sample does.
15. A result the server cut at its own row limit, an answer the console cannot read, a server that returns the same lines instead of paging, and an error the server returns fail the source with `upstream_failed` and the server's words shown. A rate limit fails it with `rate_limited` when the answer names one. A sign-in Grafana refuses fails it with `upstream_failed`, tells the operator to reconnect, and the Connector reads needs auth. A failure in one source does not stop another source's Scan.
16. Each Alert and Service shows its source, Datadog, OpenTelemetry, CloudWatch, Loki or New Relic, as a small label, and Monitor lists one source at a time through its source tabs ([monitor-source-tabs](monitor-source-tabs.md)).
17. A Service from Loki finds its code by its name, as any Service does: an imported Repo of the same name, or a link the operator sets by hand.
18. A Verification or Fix of a Loki Alert starts with a Recheck that counts the Alert's failing lines for the last hour. The Report's evidence section is headed "Log evidence".
19. The agent's brief for a Loki Alert names the source, gives the Samples and the Alert's filter, tells the agent to use no `pup` and no Datadog MCP Server, and tells it to use the Grafana MCP server's Loki tools when it needs more logs than the Samples: query logs with LogQL, list label names and values.
20. The agent may call only the Grafana server's read tools: `list_datasources`, `get_datasource`, `list_loki_label_names`, `list_loki_label_values`, `query_loki_logs`, `query_loki_stats` and `query_loki_patterns`. Any other tool of that server is refused with a reason. `run_integration` has no `logcli`.
21. Grafana's MCP server starts for a Verification of a Loki Alert and for a chat, and not for a Verification of another source's Alert, a Fix, a pull request job or a review. The agent signs in to it through Claude Code, so the console's token stays in the Keychain and the agent never sees it.
22. A PROD env is read-only like any other. The console and the agent write nothing to Loki.
23. Several sources at once: Alerts from each stay in one Monitor list under All sources, and each source has a tab. A source that is down shows its reason on its tab and in the status sentence, and the others' Alerts still show.
24. Datadog, OpenTelemetry and CloudWatch Connections, Services, Alerts, Scans and schedules are unaffected by the Loki source. The migration keeps every existing row's source, and no Alert reopens or changes Severity.
25. A reload mid-Scan, two Sessions at once and an agent that fails mid-run behave as they do for a Datadog Alert.
26. Docs: the Connectors page lists sixteen Connectors and has a "Loki logs" section: the Grafana Cloud sign-in and data source pick, the fixed label names, the formats and field names from 9, a log line example, that a self-hosted Loki is not read, and that the sign-in goes to the Keychain. The data-flow page says the daemon calls Grafana Cloud's tools with a token it holds in the Keychain, the agent reaches the same server through Claude Code, and Loki lines reach Anthropic only as Samples in a prompt or the agent's tool output.

## Settled

- **Connector id and name**: `loki_logs`, shown as Loki logs, reached through Grafana Cloud's hosted MCP server.
- **Reach**: the hosted MCP server at `https://mcp.grafana.com/mcp`, per [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md). The daemon calls it with the MCP SDK's client, which registers itself and refreshes the token. The browser comes back to a loopback callback on the daemon, so [ADR 0003](../adr/0003-local-only-server.md) holds.
- **Sign-in**: the tokens live in the Keychain, per [ADR 0004](../adr/0004-secrets-in-keychain.md), and nothing else about Loki is a secret.
- **Service**: one value of `service_name` is one Service, keyed by source, name and env. Services are discovered from the label's values, not picked.
- **Config**: `datasource_uid`, then the fields every log source has: environments, daily scan time, default Check interval, the two Severity thresholds, ignored codes and reports folder. Only the data source has a control, and only when the stack has several.
- **Window**: the Check interval of the Service. The Recheck reads the last hour.
- **Alert's stored query**: for Loki, a JSON filter on service, env, status code, method and route.
- **Retention**: an open Alert no Scan has seen for 14 days resolves, per source.
- **Limits**: the 5,000-line cap per Service holds, and the server's own row limit per call is handled by paging.
- **Error codes**: no new code. A refused pick uses `validation_failed`, a Connect that waits on a pick answers `pick_required`, and a picker read with no sign-in answers `invalid_state`.
- **No schema change**: the `connector` column takes any Connector id, so a migration seeds the Connector row and nothing more.

## Not required

- **Self-hosted Loki.** It has no OAuth path. A Loki Connector that held a self-hosted URL reads needs auth with the detail "Loki on Grafana Cloud only: the self-hosted URL is no longer read." and Reconnect connects Grafana Cloud.
- **Plain-text, access-log and logfmt lines.** The reader takes JSON lines only.
- **Other label names, a stream selector or an editable format.**
- **More than one stack, tenant or data source per Connector.** A second one is a second Connector in a later spec.
- **Live tailing.** Logs are as fresh as the last Scan, and the Alert's Freshness says so.
- **Cross-source Alert merging.** The same failure seen by two sources stays two Alerts.
- **A limit on the bytes Loki reads.** Grafana's own query limits apply.

## Safety

The agent's reach grows by one MCP server, Grafana's, which Claude Code starts and signs in. The agent may call only its read tools (20) and writes nothing. The console sends no write tool call to Grafana. The console's token stays in the Keychain and the daemon's memory for the call, and does not reach the agent, the database, a log or a response. Samples in the brief and the agent's tool output go to Anthropic's API as part of the run. A PROD env is read-only.

## Database

```sql
-- No schema change. The Connector's `config` JSON holds its fields.
INSERT INTO connectors (id, status, config) VALUES (
  'loki_logs', 'off',
  '{"datasource_uid":"","environments":["prod"],"daily_scan_time":"09:00","default_interval":"24h","rapid_errors_per_10m":100,"failing_errors_per_hour":5,"ignore":[],"reports_folder":"reports"}'
) ON CONFLICT DO NOTHING;
```

Existing rows are untouched. Every existing row keeps its source.

## API

### Common

- Every Alert, Service and Scan body already carries `connector`. Its value may be `"loki_logs"`. The endpoints that take `connector` accept it.
- The Loki Connector's `config`:

```json
{
  "datasource_uid": "string, the Loki data source of the stack; empty until chosen",
  "environments": ["prod"],
  "daily_scan_time": "09:00",
  "default_interval": "24h",
  "rapid_errors_per_10m": 100,
  "failing_errors_per_hour": 5,
  "ignore": [],
  "reports_folder": "reports"
}
```

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `connector_not_connected` | A Scan, service list or Recheck for a source whose Connector is not connected |
| 409 | `pick_required` | Connect while a sign-in waits on a data source pick and none is sent |
| 409 | `invalid_state` | The data source list read while the Connector is not signed in |
| 422 | `validation_failed` | A `datasource_uid` the sign-in cannot read |

### `POST /connectors/loki_logs/connect`

The body is empty, or `{ "datasource_uid": "<uid>" }` to pick a data source. Connect answers 202 and the sign-in and health check decide connected, needs auth or down. A second Connect while the sign-in waits changes nothing.

### `GET /connectors/loki_logs/datasources`

The Loki data sources of the signed-in stack, for the picker. Each item has `id` and `name`.

### Connectors

The existing Connector endpoints serve `loki_logs`: list, read, cancel a waiting sign-in, disconnect and check. The Connector's `pick` is `data_source` while a sign-in waits on a choice, else null. Disconnect removes Grafana's MCP server from Claude Code's config and the console's tokens from the Keychain, and leaves Grafana untouched. The picked data source stays for the next Connect.

## UI

- **Integrations**: a Connector pane for Loki logs with a Connect button and the note that Grafana Cloud is the only Loki read. After the sign-in, a stack with several Loki data sources shows a picker A to Z. States: not connected, signing in with the link and Cancel, waiting on a pick, connected with the data source's name, needs auth with Reconnect, down with the reason, checking. It follows the Connector panes of Integrations in the design.
- **Monitor**: the source label and the source tabs include Loki. States: loading, empty, a source down (the other sources' Alerts still show, with its reason on its tab), a Scan that hit the cap (its detail says so).
- **Report**: the evidence section reads "Log evidence".
- No PROD-specific state beyond the existing env tag display.

## Rejected

- **A `logcli` Connector with a typed URL, auth mode and secret**: operators did not know the values, and the daemon would hold a secret the operator typed. It also covered self-hosted Loki, which this spec leaves out. Grafana Cloud's hosted server signs in with a browser.
- **`mcp-grafana` for the agent**: it needs a Grafana URL and a service account token, and it ships write tools whose disabling flags are not confirmed to cover every one.
- **The archived `loki-mcp`**: it is archived and has one tool.
- **A pick list of streams**: label values give the Services cheaply, and an ignore list removes the noise.
- **Letting the agent run `logcli` with its own address and credential flags**: the daemon would send a secret to a host the agent names.
- **A model turn for each Scan**: each would spend tokens and read the logs differently each time.

## Glossary

- **Connector**: names Loki's data source among what it reads logs with.
- **Log source**: "Where a Scan reads failing requests from: Datadog, a Log folder, CloudWatch logs, Loki or New Relic."
- **Service**: "A deployed app the console watches in a log source, one per source, service name and env."
- **Scan**, **Sample**, **Recheck**: name the Alert's log source wherever they list the sources.

## ADR

None. Loki is a hosted-MCP Connector under [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md), and the token follows [ADR 0004](../adr/0004-secrets-in-keychain.md).

## Seams

- **Backend + SQLite** (monitor test harness, a scripted fake hosted server): 7 to 15, 17, 18, 23 and 24. A Scan reads fixture tool answers: Service discovery from label values, the env label and `no env`, the field aliases, failing by status and by level, a non-parsing line, paging and the 5,000-line cap with its note, redaction, Severity, Fingerprint with the source, a server error, a rate limit and an unreadable answer, several sources at once and one down, the Recheck, retention and Services keyed by source, and the seed row.
- **Backend + SQLite** (connectors test): 1 to 6 and 22. Connect and the pick, the tokens in the Keychain and absent from every response and the database, removing them, the health states, and the MCP registration and its removal.
- **Backend + SQLite** (agent guards and verification tests, fake agent): 18 to 21. The brief for each source, the Grafana read tools accepted and every other tool of that server refused, and the MCP scope per run purpose.
- **Browser** (Playwright e2e, `frontend/e2e/loki-connector.spec.ts` and the Monitor specs): 1, 5, 16 and 23. The Connector pane states and the picker, the source label and tabs, and a source-down reason.
- **Node test** (site build test, existing): 26. The Connectors page count and the Loki section, the data-flow lines, and the existing link and third-party checks.
- **Read in review**: 25. No new state was added for a reload or a second Session.

## Out of scope

- Self-hosted Loki, other label names and plain-text or logfmt lines.
- More than one stack or data source per Connector.
- Editing thresholds and intervals in the UI.
- The webhook receiver, which is on hold.
- Linux and Windows.
