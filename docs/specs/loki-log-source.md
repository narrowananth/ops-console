# Grafana Loki logs as a fourth log source

**Status:** shipped
**Design:** Monitor and Integrations in `design/ops-console.html`. Departure: Integrations lists a fifteenth Connector whose pane has a Loki URL, an auth mode with a secret field, label names and a format in place of a sign-in button, a folder field or a log group picker, and Alerts and Services carry a fourth source label.

## Problem

A team whose logs are in Grafana Loki, on Grafana Cloud or self-hosted, cannot use Monitor. Datadog, the OpenTelemetry Log folder and CloudWatch logs are the only log sources, and roadmap step 3 names Grafana Loki next. Loki has no browser sign-in the console can use: Grafana Cloud takes an instance ID and an access-policy token, and a self-hosted Loki takes whatever its proxy takes, or nothing. The operator types the secret once and the console keeps it in the Keychain. The console reads logs by calling Loki's own CLI, `logcli`, as it calls `pup`, `gh` and `aws`, and the agent reads more logs through the same CLI during a Verification.

## Behavior

1. Integrations lists a fifteenth Connector, Loki logs, last in the fixed order. Its pane has these fields: the Loki URL, an optional org id, the auth mode (none, bearer or basic), a username (basic only), the secret (bearer and basic only), the service label, the env label, an optional extra stream selector and the format (JSON or logfmt).
2. The service label defaults to `service_name`, the env label to `deployment_environment_name`, the selector to empty and the format to JSON. All are plain text fields apart from the format.
3. The secret goes to the Keychain when the operator connects. It never reaches the database, the logs, an API response, a WebSocket payload or the browser. The pane shows only whether a secret is set, and typing a new one replaces it. Disconnect removes it.
4. Connect needs `logcli` on the PATH. When it is missing, Connect stops and the pane names the tool and the command that installs it. The console installs nothing.
5. The health check runs a small label query through `logcli`. An answer reads connected, including a Loki with no streams yet. A 401 or 403 reads needs auth, and the pane says to check the secret and, for Grafana Cloud, that the token has `logs:read`. A URL that does not answer reads down with the reason.
6. Connecting registers no MCP Server.
7. A Scan reads every connected log source, as before. A Scan the operator starts for one source reads only that source. Loki logs runs on its own schedule from its own Check interval and daily scan time.
8. A Scan finds the Services from the values of the service label over the Scan's window, inside the extra selector. A stream with an env label reads as that env, and one without reads as `no env`. The Service is named by the label value.
9. The reader expects the format the Connector names. Each field takes the first of these names present after parsing. Status code: `status`, `statusCode`, `status_code`, `http_status_code`. Method: `method`, `httpMethod`, `http_method`. Route: `route`, `path`, `resourcePath`, `url_path`. Level: `level`, `severity`, `log_level`. Message: `message`, `msg`. Time: the time Loki stores for the line. A line that does not parse has none of these and is not read as a failure.
10. A line counts as failing when its status code is 400 or more, or its level is `error`, `critical`, `alert`, `emergency` or `fatal`, in any case.
11. A first query counts failing lines per 10-minute bucket for each Service, grouped by status code, method and route. A second query reads the newest failing lines of each Service as Samples, at most 5,000 per Service. The Scan groups them into Alerts by route, status code and masked message.
12. The Scan groups failing lines into Alerts with the same Severity rules, thresholds and Fingerprint masking as for the other sources. The Fingerprint of a Loki Alert includes the source. Existing Fingerprints do not change.
13. When a Service has more than 5,000 failing lines in the window, a Route with one message group takes its count and 10-minute peak from the full metric query, and a Route with several message groups counts the newest 5,000 lines read. The Scan's notes say so for that Service.
14. Each Sample keeps its message and fields with secret values and request body values redacted, as a Datadog Sample does.
15. A 400 from Loki's query limits, such as too many series, fails the source with Loki's reason shown. A rate limit fails it with `rate_limited` when `logcli`'s output names it. Any other failure, a rejected secret and an unreachable URL included, fails it with `upstream_failed`. A failure in one source does not stop another source's Scan.
16. Each Alert and Service shows its source, Datadog, OpenTelemetry, CloudWatch or Loki, as a small label, and Monitor filters by it.
17. A Service from Loki finds its code by its name, as any Service does: an imported Repo of the same name, or a link the operator sets by hand.
18. A Verification or Fix of a Loki Alert starts with a Recheck that counts the Alert's failing lines for the last hour. The Report's evidence section is headed "Log evidence".
19. The agent's brief for a Loki Alert names the source, gives the Samples and the Alert's filter, tells the agent to use no `pup` and no Datadog MCP Server, and tells it to use `logcli` through `run_integration` when it needs more logs than the Samples.
20. `run_integration` accepts `logcli`. It allows the read commands (a log or metric query, listing labels and label values, series) and a fixed set of flags for time range, limit, output format and quiet. It refuses every flag that changes the address, the org id, the credentials, the TLS settings or a proxy, and every other command. A refused call says why and runs nothing.
21. `logcli` runs as the operator outside the Run sandbox, and the daemon puts the Connector's address, org id and secret in its environment. The agent never sees the secret, and neither does a tool call's output.
22. A PROD env is read-only like any other. The console and the agent write nothing to Loki.
23. Four sources at once: Alerts from each stay in one Monitor list, filterable by source. A source that is down shows a notice naming it, and the others' Alerts still show.
24. Existing Datadog, OpenTelemetry and CloudWatch Connections, Services, Alerts, Scans and schedules behave as before. After the update every existing row keeps its source, and no Alert reopens or changes Severity.
25. A reload mid-Scan, two Sessions at once and an agent that fails mid-run behave as they do for a Datadog Alert.
26. Docs: the Connectors page lists fifteen Connectors and has a "Loki logs" section: Grafana Cloud and self-hosted setup, the `logs:read` token, the formats and field names from 9, a log line example, and that the secret goes to the Keychain. The data-flow page says the daemon calls `logcli` as the operator, the agent reaches Loki through `run_integration`, and Loki lines reach Anthropic only as Samples in a prompt or the agent's tool output.

## Settled

- **Connector id and name**: `loki_logs`, shown as Loki logs.
- **Reach**: the `logcli` CLI only, per [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md). Neither the daemon nor the console has a direct HTTP client for Loki.
- **Auth**: none, bearer or basic. `logcli` refuses basic and bearer together, so one mode applies. Grafana Cloud uses basic, with the instance ID as the username and an access-policy token as the password. Loki has no sign-in the console can use, so the secret is typed, as ADR 0005 allows when the provider ships no OAuth client.
- **Secret**: the only value in the Keychain, per [ADR 0004](../adr/0004-secrets-in-keychain.md). The daemon reads it when it runs `logcli` and passes it in the child's environment, never on the command line.
- **Service**: one value of the service label is one Service, keyed by source, name and env. Services are discovered from the label's values, not picked.
- **Config**: `url`, `org_id`, `auth`, `username`, `service_label`, `env_label`, `selector` and `format`, then the fields every log source has: environments, daily scan time, default Check interval, the two Severity thresholds, ignored codes and reports folder. Only the first eight have fields in this change.
- **Window**: the Check interval of the Service. The Recheck reads the last hour.
- **Alert's stored query**: for Loki, a JSON filter on service, env, status code, method and route.
- **Retention**: unchanged. An open Alert no Scan has seen for 14 days resolves, per source.
- **Limits**: the 5,000-line cap matches Loki's default entry limit per query. A Loki with different limits fails or cuts the read, and the Scan says so.
- **Error codes**: no new code. A missing `logcli` uses `tool_missing`.
- **No schema change**: #122 dropped the `connector` `CHECK`, so the migration seeds the Connector row and nothing more.
- **Unconfirmed**: the output shape of a metric query through `logcli`, whether `logcli`'s output names a 429, and the LogQL that applies the aliases. `/ship` checks them against `logcli`'s source and documentation, and the spec's tests use a scripted fake.

## Not required

- **Plain-text, access-log and other formats.** One format per Connector, JSON or logfmt.
- **Loki behind a Grafana instance.** The Connector takes a Loki URL, not Grafana's datasource proxy and a service account.
- **Grafana Cloud's browser sign-in.** It belongs to a different CLI and was not confirmed to query Loki.
- **More than one tenant or URL per Connector.** A second one is a second Connector in a later spec.
- **An MCP Server for Loki.** The agent uses `logcli`.
- **Live tailing.** Logs are as fresh as the last Scan, and the Alert's Freshness says so.
- **Cross-source Alert merging.** The same failure seen by two sources stays two Alerts.
- **A limit on the bytes Loki reads.** Loki's own query limits apply.

## Safety

The agent's reach grows by one CLI: `logcli` through `run_integration`, as the operator, outside the Run sandbox, as `gh` and `pup` already run. The command and flag allowlist in 20 keeps the agent from changing where the daemon sends the secret, since the address and credentials come from the daemon and the agent cannot override them. The agent reads logs and writes nothing. The secret stays in the Keychain and the daemon's environment for the child, and does not reach the agent, the database, a log or a response. Samples in the brief and the agent's tool output go to Anthropic's API as part of the run. A PROD env is read-only.

## Database

```sql
-- No schema change. The Connector's `config` JSON holds its fields.
INSERT INTO connectors (id, status, config) VALUES (
  'loki_logs', 'off',
  '{"url":"","org_id":"","auth":"none","username":"","service_label":"service_name","env_label":"deployment_environment_name","selector":"","format":"json","environments":["prod"],"daily_scan_time":"09:00","default_interval":"24h","rapid_errors_per_10m":100,"failing_errors_per_hour":5,"ignore":[],"reports_folder":"reports"}'
) ON CONFLICT DO NOTHING;
```

Existing rows are untouched. Every existing row keeps its source.

## API

### Common

- Every Alert, Service and Scan body already carries `connector`. Its value may now be `"loki_logs"`. The endpoints that take `connector` accept it.
- The Loki Connector's `config`. The secret is not in it:

```json
{
  "url": "string, a Loki URL such as https://loki.example.com; empty until chosen",
  "org_id": "string, the X-Scope-OrgID tenant; empty for none",
  "auth": "none | bearer | basic",
  "username": "string, for basic only",
  "service_label": "service_name",
  "env_label": "deployment_environment_name",
  "selector": "string, extra stream matchers such as cluster=\"prod-1\"; empty for none",
  "format": "json | logfmt",
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
| 422 | `tool_missing` | Connecting with no `logcli` on the PATH; the body names the tool and the install command |
| 422 | `validation_failed` | A bad URL, a basic mode with no username, a bearer or basic mode with no secret, or a label or selector that is not valid LogQL |

### `POST /connectors/loki_logs/connect`

The body is the config fields above plus `secret`, a write-only string for bearer and basic modes. It is never returned, and a body that leaves it out keeps the stored one. Connect answers 202 and the health check decides connected, needs auth or down.

### Connectors

The existing Connector endpoints serve `loki_logs`: list, read, disconnect and check. Disconnect removes the secret from the Keychain and leaves Loki untouched.

## UI

- **Integrations**: a Connector pane for Loki logs with the fields in 1. The secret field shows set or not set and never its value. States: not connected, connected with the URL shown, needs auth with what to check, down with the reason (`logcli` missing, URL unreachable), checking. It follows the Connector panes of Integrations in the design; the fields replace the sign-in step.
- **Monitor**: the source label gains Loki and the source filter lists four sources. States: loading, empty, a source down (the other sources' Alerts still show, with a notice naming it), a Scan that hit the cap (its detail says so).
- **Report**: the evidence section reads "Log evidence".
- No PROD-specific state beyond the existing env tag display.

## Rejected

- **A direct HTTP client in the daemon**: clearer status codes, but ADR 0005 says every outside system is an MCP server or a CLI, so it needs an ADR rewrite first. `logcli` fits as it is.
- **Grafana's `mcp-grafana` for the agent**: it needs a Grafana URL and a service account token beside the Loki secret, and it ships write tools whose disabling flags are not confirmed to cover every one.
- **The archived `loki-mcp`**: it uses the same credentials but is archived and has one tool.
- **Grafana's hosted MCP with OAuth**: Grafana Cloud only, and it leaves the self-hosted Loki without a route.
- **A pick list of streams**: label values give the Services cheaply, and an ignore list removes the noise.
- **One fixed set of label names**: Loki setups differ, with `service_name`, `app`, `job`, `env`, `environment` and more, so the names are fields.
- **Letting the agent pass `--addr` and credential flags**: the daemon would send the secret to a host the agent names.

## Glossary

- **Connector**: widened to "An outside service the operator signs in to, or a Log folder, an AWS profile or a Loki URL it reads logs with. It holds the sign-in, folder, profile or URL and registers the service's MCP Server when it has one."
- **Log source**: "Where a Scan reads failing requests from: Datadog, a Log folder, CloudWatch logs or Loki."
- **Service**: "A deployed app the console watches in a log source, one per source, service name and env."
- **Scan**, **Sample**, **Recheck**: name the Alert's log source wherever they list the sources.

## ADR

None. Loki is a CLI Connector under [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md), and the secret follows [ADR 0004](../adr/0004-secrets-in-keychain.md).

## Seams

- **Backend + SQLite** (monitor test harness, a scripted fake `logcli`): 7 to 15, 17, 18, 23 and 24. A Scan reads fixture `logcli` answers: Service discovery from label values and the selector, the env label and `no env`, both formats, the field aliases, failing by status and by level, a non-parsing line, the 5,000-line cap and its note, redaction, Severity, Fingerprint with the source, a 400 limit, a rate limit and other failures, four sources at once and one down, the Recheck, retention and Services keyed by source, and the seed row.
- **Backend + SQLite** (connectors test): 1 to 6, 21 and 22. Connect in each auth mode, the secret in the Keychain and absent from every response and the database, replacing and removing it, the health states, `tool_missing`, config validation, and no MCP registration.
- **Backend + SQLite** (agent guards and verification tests, fake agent): 18 to 21. The brief for each source, `logcli` accepted with the allowed flags and every address, credential, TLS and proxy flag refused, other commands refused, and the secret absent from the agent's input and output.
- **Browser** (Playwright e2e, existing): 1, 2, 5, 16 and 23. The Connector pane states and fields, the secret never shown, the source label and filter with four sources, and a source-down notice.
- **Node test** (site build test, existing): 26. The Connectors page count and the Loki section, the data-flow lines, and the existing link and third-party checks.
- **Read in review**: 25. No new state was added for a reload or a second Session.

## Out of scope

- New Relic, the last item of roadmap step 3.
- Loki behind Grafana, Grafana Cloud's browser sign-in and an MCP Server for Loki.
- Access-log and plain-text formats.
- More than one tenant or URL per Connector.
- Editing thresholds and intervals in the UI.
- The webhook receiver, which is on hold.
- Linux and Windows.
