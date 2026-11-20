# New Relic logs as a fifth log source

**Status:** shipped
**Design:** Monitor and Integrations in `design/ops-console.html`. Departure: Integrations lists a sixteenth Connector whose pane has an account ID, a region, an API key field and attribute names in place of a sign-in button, a folder field, a log group picker or a Loki URL, and Alerts and Services carry a fifth source label.

## Problem

A team whose logs are in New Relic cannot use Monitor. Datadog, the OpenTelemetry Log folder, CloudWatch logs and Loki are the only log sources, and roadmap step 3 names New Relic as the last of them. New Relic's own CLI has no browser sign-in. Its hosted MCP server has one, but the daemon cannot use that token, and the Scan needs a credential of its own. So the operator types a User API key once and the console keeps it in the Keychain. The console reads logs by calling the `newrelic` CLI as it calls `pup`, `gh`, `aws` and `logcli`, and the agent reads more logs through the same CLI during a Verification.

## Behavior

1. Integrations lists a sixteenth Connector, New Relic logs, last in the fixed order. Its pane has these fields: the account ID, the region (US, EU or JP), the API key, the service attribute, the env attribute and an optional extra filter.
2. The service attribute defaults to `service.name` and the env attribute to `environment`. Both are plain text fields. The filter defaults to empty and holds one condition of the kind that follows `WHERE`, such as `cluster = 'prod-1'`.
3. The API key goes to the Keychain when the operator connects. It never reaches the database, the logs, an API response, a WebSocket payload or the browser. The pane shows only whether a key is set, and typing a new one replaces it. Disconnect removes it.
4. Connect needs `newrelic` on the PATH. When it is missing, Connect stops and the pane names the tool and the command that installs it. The console installs nothing.
5. The health check runs a small query through `newrelic`. An answer reads connected, including an account with no logs yet. A 401 or 403 reads needs auth, and the pane says to check the key and that a key belongs to one region. An address that does not answer reads down with the reason.
6. Connecting registers no MCP Server.
7. A Scan reads every connected log source, as before. A Scan the operator starts for one source reads only that source. New Relic logs runs on its own schedule from its own Check interval and daily scan time.
8. A Scan finds the Services from the distinct values of the service attribute on failing events over the Scan's window, inside the extra filter. An event with no env attribute reads as the env `no env`. The Service is named by the attribute's value.
9. For each Service in a Scan, the reader asks New Relic which attributes the Service's logs have, and uses the first of these names present. Status code: `http.response.status_code`, `http.status_code`, `status`, `statusCode`, `status_code`. Method: `http.request.method`, `http.method`, `method`, `httpMethod`. Route: `http.route`, `url.path`, `route`, `path`, `resourcePath`. Level: `level`, `severity.text`, `severity`, `log_level`. Message: `message`, `msg`. Time: the event's own timestamp. A Service whose logs have no status attribute is read by level only.
10. An event counts as failing when its status code is 400 or more, or its level is `error`, `critical`, `alert`, `emergency` or `fatal`, in any case.
11. A first query counts failing events per 10-minute bucket for each Service, grouped by status code, method and route. A second query reads the newest failing events of each Service as Samples, at most 5,000 per Service. The Scan groups them into Alerts by route, status code and masked message. A window longer than 61 hours reads the newest 61 hours for the counts, and the Scan's notes say so.
12. The Scan groups failing events into Alerts with the same Severity rules, thresholds and Fingerprint masking as for the other sources. The Fingerprint of a New Relic Alert includes the source. Existing Fingerprints do not change.
13. When a Service has more than 5,000 failing events in the window, a Route with one message group takes its count and 10-minute peak from the full counts query, and a Route with several message groups counts the newest 5,000 events read. The Scan's notes say so for that Service.
14. Each Sample keeps its message and attributes with secret values and request body values redacted, as a Datadog Sample does.
15. A query that times out or that New Relic rejects, with a 400 or a syntax error, fails the source with New Relic's reason shown. A rate limit fails it with `rate_limited` when the CLI's output names it. Any other failure, a rejected key and an unreachable address included, fails it with `upstream_failed`. A failure in one source does not stop another source's Scan.
16. Each Alert and Service shows its source, Datadog, OpenTelemetry, CloudWatch, Loki or New Relic, as a small label, and Monitor filters by it.
17. A Service from New Relic finds its code by its name, as any Service does: an imported Repo of the same name, or a link the operator sets by hand.
18. A Verification or Fix of a New Relic Alert starts with a Recheck that counts the Alert's failing events for the last hour. The Report's evidence section is headed "Log evidence".
19. The agent's brief for a New Relic Alert names the source, gives the Samples and the Alert's filter, tells the agent to use no `pup` and no Datadog MCP Server, and tells it to use `newrelic` through `run_integration` when it needs more logs than the Samples.
20. `run_integration` accepts `newrelic`. It allows only the `nrql query` command with the `--query` and `--format` flags. It refuses every other flag, in particular the key, account, region and profile flags and the debug and trace flags, every other command including `nerdgraph`, and a flag value that is empty or starts with `-`, in both `--flag value` and `--flag=value` form. A refused call says why and runs nothing.
21. `newrelic` runs as the operator outside the Run sandbox, and the daemon puts the Connector's key, account ID and region in its environment. The agent never sees the key, and neither does a tool call's output. An operator's own `NEW_RELIC_*` variables in the daemon's environment do not reach the child. With no key stored, `run_integration` refuses a `newrelic` call and a health check reads needs auth without running the CLI, so the operator's own New Relic profile is never used.
22. A PROD env is read-only like any other. The console and the agent write nothing to New Relic.
23. Five sources at once: Alerts from each stay in one Monitor list, filterable by source. A source that is down shows a notice naming it, and the others' Alerts still show.
24. Existing Datadog, OpenTelemetry, CloudWatch and Loki Connections, Services, Alerts, Scans and schedules behave as before. After the update every existing row keeps its source, and no Alert reopens or changes Severity.
25. A reload mid-Scan, two Sessions at once and an agent that fails mid-run behave as they do for a Datadog Alert.
26. Docs: the Connectors page lists sixteen Connectors and has a "New Relic logs" section: the prerequisite and its install command, where to find the account ID, the region and key, the attributes and filter, the field names from 9, the 5,000-event cap, that the key goes to the Keychain, and that the agent's NRQL reads any event type in the account and a User key reaches every account its user can open, so a dedicated user with a read-only role is advised. The data-flow page says the daemon calls `newrelic` as the operator, the agent reaches New Relic through `run_integration`, and New Relic events reach Anthropic only as Samples in a prompt or the agent's tool output.

## Settled

- **Connector id and name**: `new_relic_logs`, shown as New Relic logs.
- **Reach**: the `newrelic` CLI only, per [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md). Neither the daemon nor the console has a direct HTTP client for New Relic.
- **Credential**: a User API key, typed once. New Relic's hosted MCP server has a browser sign-in, but that token belongs to Claude Code and the daemon cannot use it, so the key stays. The secret is the only value in the Keychain, per [ADR 0004](../adr/0004-secrets-in-keychain.md), and the daemon passes it in the child's environment, never on the command line.
- **Agent route**: the same CLI through `run_integration`, not the hosted MCP server. One credential, every plan, and no admin toggles.
- **Service**: one value of the service attribute is one Service, keyed by source, name and env. Services are discovered, not picked.
- **Field names**: found for each Service from New Relic itself, because the names depend on the forwarder.
- **Config**: `account_id`, `region`, `service_attribute`, `env_attribute` and `filter`, then the fields every log source has: environments, daily scan time, default Check interval, the two Severity thresholds, ignored codes and reports folder. Only the first five have fields in this change.
- **Validation**: the account ID is digits only. The attribute names match a plain attribute name pattern and are quoted when the query is built. The filter is refused when it holds text that would end its condition or add a clause the reader adds itself, such as `SINCE`, `UNTIL`, `LIMIT`, `FACET`, `TIMESERIES` or `ORDER BY`, or a semicolon.
- **Window**: the Check interval of the Service. The Recheck reads the last hour.
- **Alert's stored query**: for New Relic, a JSON filter on service, env, status code, method and route.
- **Retention**: unchanged. An open Alert no Scan has seen for 14 days resolves, per source.
- **Limits**: the 5,000-event cap matches New Relic's `LIMIT` ceiling. The counts query groups by three attributes, under New Relic's limit of five.
- **Error codes**: no new code. A missing `newrelic` uses `tool_missing`, and bad config uses `validation_failed`.
- **No schema change**: the `connector` column takes any Connector id since #122, so the migration seeds the Connector row and nothing more.
- **Unconfirmed**: the CLI's stderr text for a 401, a syntax error and a 429, whether `numeric()` works in a `WHERE` on a string status, the exact NRQL for the attribute discovery, and whether the Homebrew bottle covers Intel Macs. `/ship` checks them against New Relic's documentation and the CLI's source, and the spec's tests use a scripted fake.

## Not required

- **Plain-text and access-log formats.** The reader uses the attributes New Relic has already parsed.
- **A check of the JP region.** It is offered because the CLI documents it, and no test or run uses it.
- **More than one account or key per Connector.** A second one is a second Connector in a later spec.
- **New Relic's hosted MCP server.** The agent uses `newrelic`.
- **A read-only key.** New Relic documents none. Permissions come from the user's roles.
- **Live tailing.** Logs are as fresh as the last Scan, and the Alert's Freshness says so.
- **Cross-source Alert merging.** The same failure seen by two sources stays two Alerts.
- **A limit on the data New Relic scans.** New Relic's own query limits apply.

## Safety

The agent's reach grows by one CLI: `newrelic` through `run_integration`, as the operator, outside the Run sandbox, as `gh`, `pup` and `logcli` already run. The command and flag allowlist in 20 keeps the agent from changing the key, account or region the daemon supplies. The agent reads and writes nothing in New Relic's configuration. Its NRQL can read any event type in the account, not only logs, and a User key reaches every account its user can open, so the docs advise a dedicated user with a read-only role. The key stays in the Keychain and the daemon's environment for the child, and does not reach the agent, the database, a log or a response. Samples in the brief and the agent's tool output go to Anthropic's API as part of the run. A PROD env is read-only.

## Database

```sql
-- No schema change. The Connector's `config` JSON holds its fields.
INSERT INTO connectors (id, status, config) VALUES (
  'new_relic_logs', 'off',
  '{"account_id":"","region":"US","service_attribute":"service.name","env_attribute":"environment","filter":"","environments":["prod"],"daily_scan_time":"09:00","default_interval":"24h","rapid_errors_per_10m":100,"failing_errors_per_hour":5,"ignore":[],"reports_folder":"reports"}'
) ON CONFLICT DO NOTHING;
```

Existing rows are untouched. Every existing row keeps its source.

## API

### Common

- Every Alert, Service and Scan body already carries `connector`. Its value may now be `"new_relic_logs"`. The endpoints that take `connector` accept it.
- The New Relic Connector's `config`. The key is not in it:

```json
{
  "account_id": "string, digits only; empty until chosen",
  "region": "US | EU | JP",
  "service_attribute": "service.name",
  "env_attribute": "environment",
  "filter": "string, one condition such as cluster = 'prod-1'; empty for none",
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
| 422 | `tool_missing` | Connecting with no `newrelic` on the PATH; the body names the tool and the install command |
| 422 | `validation_failed` | An account ID that is not digits, no key on a first Connect, an attribute name that is not valid, or a filter that holds a refused clause |

### `POST /connectors/new_relic_logs/connect`

The body is the config fields above plus `secret`, a write-only string holding the API key. It is never returned, and a body that leaves it out keeps the stored one. Connect answers 202 and the health check decides connected, needs auth or down.

### Connectors

The existing Connector endpoints serve `new_relic_logs`: list, read, disconnect and check. Disconnect removes the key from the Keychain and leaves New Relic untouched.

## UI

- **Integrations**: a Connector pane for New Relic logs with the fields in 1. The key field shows set or not set and never its value. States: not connected, connected with the account ID shown, needs auth with what to check, down with the reason (`newrelic` missing, unreachable), checking. It follows the Connector panes of Integrations in the design; the fields replace the sign-in step.
- **Monitor**: the source label gains New Relic and the source filter lists five sources. States: loading, empty, a source down (the other sources' Alerts still show, with a notice naming it), a Scan that hit the cap (its detail says so).
- **Report**: the evidence section reads "Log evidence".
- No PROD-specific state beyond the existing env tag display.

## Rejected

- **A direct NerdGraph client in the daemon**: clearer status codes, but ADR 0005 says every outside system is an MCP server or a CLI, so it needs an ADR rewrite first. The `newrelic` CLI fits as it is.
- **New Relic's hosted MCP server for the agent**: its browser sign-in suits ADR 0005, but the daemon cannot use that token, so the operator would hold two credentials. It also needs a paid plan and two admin toggles, and the sign-in lapses after 24 hours.
- **The hosted MCP server for the whole source, with no typed key**: a Scan runs with no model turn, and the daemon holds no OAuth token for it.
- **A fixed set of attribute names in the query**: NRQL has no confirmed fallback between names, and forwarders differ, so the reader asks New Relic which names exist.
- **A pick list of Services**: `uniques()` gives them cheaply, and an ignore list removes the noise.
- **Letting the agent pass the key, account or region flags**: the daemon would send the key to an account or region the agent names.

## Glossary

- **Connector**: widened to "An outside service the operator signs in to, or a Log folder, an AWS profile, a Loki URL or a New Relic account it reads logs with. It holds the sign-in, folder, profile, URL or account and registers the service's MCP Server when it has one."
- **Log source**: "Where a Scan reads failing requests from: Datadog, a Log folder, CloudWatch logs, Loki or New Relic."
- **Service**: "A deployed app the console watches in a log source, one per source, service name and env."
- **Scan**, **Sample**, **Recheck**: name the Alert's log source wherever they list the sources.

## ADR

None. New Relic is a CLI Connector under [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md), and the key follows [ADR 0004](../adr/0004-secrets-in-keychain.md). ADR 0004 gains one line naming the key `connection:new_relic_logs`.

## Seams

- **Backend + SQLite** (monitor test harness, a scripted fake `newrelic`): 7 to 15, 17, 18, 23 and 24. A Scan reads fixture `newrelic` answers: Service discovery from the distinct values and the filter, the env attribute and `no env`, the attribute discovery and each alias, failing by status and by level, a Service with no status attribute, the 5,000-event cap and its note, redaction, Severity, Fingerprint with the source, a timeout, a syntax error, a rate limit and other failures, five sources at once and one down, the Recheck, retention, Services keyed by source and the seed row.
- **Backend + SQLite** (connectors test): 1 to 6, 21 and 22. Connect with a key, the key in the Keychain and absent from every response and the database, replacing and removing it, the health states, `tool_missing`, config validation including the filter, and no MCP registration.
- **Backend + SQLite** (agent guards and verification tests, fake agent): 18 to 21. The brief for each source, `newrelic` accepted with `nrql query --query --format` only, every key, account, region, profile, debug and trace flag refused, other commands refused, a flag value starting with `-` refused, the secret absent from the agent's input and output, and an ambient `NEW_RELIC_*` variable not reaching the child.
- **Browser** (Playwright e2e, existing): 1, 2, 5, 16 and 23. The Connector pane states and fields, the key never shown, the source label and filter with five sources, and a source-down notice.
- **Node test** (site build test, existing): 26. The Connectors page count and the New Relic section, the data-flow lines, and the existing link and third-party checks.
- **Read in review**: 25. No new state was added for a reload or a second Session.

## Out of scope

- New Relic's hosted MCP server and its browser sign-in.
- More than one account, key or region per Connector.
- A read-only key, which New Relic does not document.
- Access-log and plain-text formats.
- Editing thresholds and intervals in the UI.
- The webhook receiver, which is on hold.
- Linux and Windows.
