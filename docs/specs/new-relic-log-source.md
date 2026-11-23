# New Relic logs as a fifth log source

**Status:** shipped. How New Relic connects, the credential and the agent's reach (1 to 6, 15, 18 to 21, 26 and the matching parts of the sections below) are replaced by [one-click-log-sources](one-click-log-sources.md). How logs are read, grouped and shown holds.
**Design:** Monitor and Integrations in `design/ops-console.html`. Departure: Integrations lists a sixteenth Connector, and Alerts and Services carry a fifth source label.

## Problem

A team whose logs are in New Relic cannot use Monitor with only Datadog, the OpenTelemetry Log folder, CloudWatch logs and Loki. New Relic is the fifth log source. The console reads its logs with NRQL queries, through New Relic's hosted MCP server or with a User API key (see one-click-log-sources), and the agent reads more logs through the same account during a Verification.

## Behavior

1. Integrations lists a sixteenth Connector, New Relic logs, last in the fixed order. Its pane has a Region choice, Connect, an account picker after sign-in and a quiet "Use a User API key instead" ([one-click-log-sources](one-click-log-sources.md) 3, 23).
2. The service attribute is `service.name` and the env attribute is `environment`. Neither is a setting, and there is no extra filter.
3. A User API key, when the operator uses one, goes to the Keychain when the operator connects. It never reaches the database, the logs, an API response, a WebSocket payload or the browser. Disconnect removes it. The MCP sign-in belongs to Claude Code and is read in memory for each call.
4. Connect needs no CLI.
5. The health check lists the accounts the route in use can read and finds the picked one. An answer reads connected, including an account with no logs yet. A rejected or expired sign-in or key reads needs auth. A server that does not answer reads down with the reason.
6. Connecting with the MCP sign-in registers New Relic's MCP Server with Claude Code. Connecting with a key registers none and removes it.
7. A Scan reads every connected log source, as before. A Scan the operator starts for one source reads only that source. New Relic logs runs on its own schedule from its own Check interval and daily scan time.
8. A Scan finds the Services from the distinct values of the service attribute on failing events over the Scan's window. An event with no env attribute reads as the env `no env`. The Service is named by the attribute's value.
9. For each Service in a Scan, the reader asks New Relic which attributes the Service's logs have, and uses the first of these names present. Status code: `http.response.status_code`, `http.status_code`, `status`, `statusCode`, `status_code`. Method: `http.request.method`, `http.method`, `method`, `httpMethod`. Route: `http.route`, `url.path`, `route`, `path`, `resourcePath`. Level: `level`, `severity.text`, `severity`, `log_level`. Message: `message`, `msg`. Time: the event's own timestamp. A Service whose logs have no status attribute is read by level only.
10. An event counts as failing when its status code is 400 or more, or its level is `error`, `critical`, `alert`, `emergency` or `fatal`, in any case.
11. A first query counts failing events per 10-minute bucket for each Service, grouped by status code, method and route. A second query reads the newest failing events of each Service as Samples, at most 5,000 per Service. The Scan groups them into Alerts by route, status code and masked message. A window longer than 61 hours reads the newest 61 hours for the counts, and the Scan's notes say so.
12. The Scan groups failing events into Alerts with the same Severity rules, thresholds and Fingerprint masking as for the other sources. The Fingerprint of a New Relic Alert includes the source. Existing Fingerprints do not change.
13. When a Service has more than 5,000 failing events in the window, a Route with one message group takes its count and 10-minute peak from the full counts query, and a Route with several message groups counts the newest 5,000 events read. The Scan's notes say so for that Service.
14. Each Sample keeps its message and attributes with secret values and request body values redacted, as a Datadog Sample does.
15. A query that New Relic rejects fails the source with New Relic's reason shown. A rate limit fails it with `rate_limited`. Any other failure, an unreachable server included, fails it with `upstream_failed`. A refused sign-in or key also turns the Connector to needs auth. A failure in one source does not stop another source's Scan.
16. Each Alert and Service shows its source, Datadog, OpenTelemetry, CloudWatch, Loki or New Relic, as a small label, and Monitor filters by it.
17. A Service from New Relic finds its code as any Service does ([monitor-source-tabs](monitor-source-tabs.md) 11), or the operator links a Repo by hand.
18. A Verification or Fix of a New Relic Alert starts with a Recheck that counts the Alert's failing events in the Recheck window. The Report's evidence section is headed "Log evidence".
19. The agent's brief for a New Relic Alert names the source, gives the Samples and the Alert's filter, tells the agent to use no `pup` and no Datadog MCP Server, and names the tool it has for more logs: New Relic's MCP Server on the MCP route, the console's `query_new_relic` tool on the key route.
20. `run_integration` has no `newrelic` command. On the MCP route the agent may call only New Relic's NRQL query and account list tools; any other tool of that server is refused with a reason.
21. On the key route the daemon runs the agent's NRQL itself: `query_new_relic` takes NRQL text only, refuses anything but a `SELECT`, `FROM` or `SHOW` query, returns at most 200 rows and writes an Action Log row. The agent never sees the key.
22. A PROD env is read-only like any other. The console and the agent write nothing to New Relic.
23. Five sources at once: Alerts from each stay in one Monitor list, filterable by source. A source that is down shows a notice naming it, and the others' Alerts still show.
24. Existing Datadog, OpenTelemetry, CloudWatch and Loki Connections, Services, Alerts, Scans and schedules behave as before. After the update every existing row keeps its source, and no Alert reopens or changes Severity.
25. A reload mid-Scan, two Sessions at once and an agent that fails mid-run behave as they do for a Datadog Alert.
26. Docs: the Connectors page lists sixteen Connectors and has a "New Relic logs" section: the sign-in, the Region, the field names from 9, the 5,000-event cap, the key route and that a User key reaches every account its user can open, so a dedicated user with a read-only role is advised. The data-flow page says how the daemon and the agent reach New Relic, and that New Relic events reach Anthropic only as Samples in a prompt or the agent's tool output.

## Settled

- **Connector id and name**: `new_relic_logs`, shown as New Relic logs.
- **Reach**: New Relic's hosted MCP server with the sign-in Claude Code stored, or New Relic's API with a User API key, per [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md) and [one-click-log-sources](one-click-log-sources.md). The queries are the same on both routes.
- **Credential**: the MCP sign-in belongs to Claude Code. A User API key is the only New Relic value in the Keychain, per [ADR 0004](../adr/0004-secrets-in-keychain.md), and the daemon sends it in a request header, never on a command line.
- **Agent route**: New Relic's MCP server on the MCP route, restricted to its NRQL and account tools; the console's `query_new_relic` tool on the key route.
- **Service**: one value of the service attribute is one Service, keyed by source, name and env. Services are discovered, not picked.
- **Field names**: found for each Service from New Relic itself, because the names depend on the forwarder.
- **Config**: `account_id`, `region` and `route`, then the fields every log source has: environments, daily scan time, default Check interval, the two Severity thresholds, ignored codes and reports folder. Only the Region and the account have a control.
- **Validation**: the account ID is digits only, and the Region is US, EU or JP. Attribute names are quoted and values escaped when a query is built.
- **Window**: the Check interval of the Service. The Recheck reads the last hour.
- **Alert's stored query**: for New Relic, a JSON filter on service, env, status code, method and route.
- **Retention**: unchanged. An open Alert no Scan has seen for 14 days resolves, per source.
- **Limits**: the 5,000-event cap matches New Relic's `LIMIT` ceiling. The counts query groups by three attributes, under New Relic's limit of five.
- **Error codes**: no new code. Bad config uses `validation_failed`.
- **No schema change**: the `connector` column takes any Connector id, so a migration seeds the Connector row and nothing more.

## Not required

- **Plain-text and access-log formats.** The reader uses the attributes New Relic has already parsed.
- **A check of the JP region.** It is offered because New Relic documents it, and no test or run uses it.
- **More than one account or key per Connector.** A second one is a second Connector in a later spec.
- **A read-only key.** New Relic documents none. Permissions come from the user's roles.
- **Live tailing.** Logs are as fresh as the last Scan, and the Alert's Freshness says so.
- **Cross-source Alert merging.** The same failure seen by two sources stays two Alerts.
- **A limit on the data New Relic scans.** New Relic's own query limits apply.

## Safety

The agent reads New Relic through one of two read-only paths: the hosted server's NRQL and account tools, or `query_new_relic` (see 20 and 21). It writes nothing in New Relic. Its NRQL can read any event type in the account, not only logs, and a User key reaches every account its user can open, so the docs advise a dedicated user with a read-only role. The key stays in the Keychain and the daemon, and does not reach the agent, the database, a log or a response. Samples in the brief and the agent's tool output go to Anthropic's API as part of the run. A PROD env is read-only.

## Database

The Connector's `config` JSON holds its fields. Migration 0045 seeds the row and 0047 rewrites it to the fields below.

```json
{ "account_id": "", "region": "US", "route": "mcp", "environments": ["prod"], "daily_scan_time": "09:00",
  "default_interval": "24h", "rapid_errors_per_10m": 100, "failing_errors_per_hour": 5, "ignore": [],
  "reports_folder": "reports" }
```

Every existing row keeps its source.

## API

### Common

- Every Alert, Service and Scan body already carries `connector`. Its value may be `"new_relic_logs"`. The endpoints that take `connector` accept it.
- The New Relic Connector's `config` is the JSON above. The key is not in it.

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `connector_not_connected` | A Scan, service list or Recheck for a source whose Connector is not connected |
| 422 | `validation_failed` | An account ID that is not digits, or New Relic refused the key |

### Connectors

`POST /connectors/new_relic_logs/connect` and the other Connector endpoints serve `new_relic_logs`; the connect body is in [one-click-log-sources](one-click-log-sources.md). Disconnect removes the key from the Keychain and leaves New Relic untouched.

## UI

- **Integrations**: a Connector pane for New Relic logs, described in [one-click-log-sources](one-click-log-sources.md).
- **Monitor**: the source label gains New Relic and the source tabs list five sources. States: loading, empty, a source down (the other sources' Alerts still show, with a notice naming it), a Scan that hit the cap (its detail says so).
- **Report**: the evidence section reads "Log evidence".
- No PROD-specific state beyond the existing env tag display.

## Rejected

- **A fixed set of attribute names in the query**: NRQL has no confirmed fallback between names, and forwarders differ, so the reader asks New Relic which names exist.
- **A pick list of Services**: `uniques()` gives them cheaply, and an ignore list removes the noise.
- **The `newrelic` CLI and typed fields**: it needed an install, a typed key, account, Region and attribute names. [one-click-log-sources](one-click-log-sources.md) replaces it.

## Glossary

- **Connector**: includes a New Relic account the console reads logs with.
- **Log source**: lists New Relic with Datadog, a Log folder, CloudWatch logs and Loki.
- **Scan**, **Sample**, **Recheck**: name the Alert's log source wherever they list the sources.

## ADR

None of its own. New Relic follows [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md), and the key follows [ADR 0004](../adr/0004-secrets-in-keychain.md).

## Seams

- **Backend + SQLite** (`backend/test/monitor.test.ts`, scripted New Relic answers): 7 to 15, 17, 18, 23 and 24. A Scan reads fixture answers: Service discovery from the distinct values, the env attribute and `no env`, the attribute discovery and each alias, failing by status and by level, a Service with no status attribute, the 5,000-event cap and its note, redaction, Severity, Fingerprint with the source, a rate limit and other failures, five sources at once and one down, the Recheck, retention and Services keyed by source.
- **Backend + SQLite** (`backend/test/connectors.test.ts`): 1 to 6. Connect on each route, the key in the Keychain and absent from every response and the database, the health states and the MCP registration.
- **Backend + SQLite** (`backend/test/agent-guards.test.ts`): 18 to 21. The brief for each source, only New Relic's read tools allowed, `newrelic` absent from `run_integration`, `query_new_relic` refusing anything but `SELECT`, `FROM` or `SHOW`, and the key absent from the agent's input and output.
- **Browser** (`frontend/e2e/new-relic-connector.spec.ts` and `monitor-lists.spec.ts`): 1, 5, 16 and 23. The Connector pane states, the key never shown, the source label and tabs with five sources, and a source-down notice.
- **Node test** (`site/build.test.mjs`): 26. The Connectors page count and the New Relic section, the data-flow lines, and the existing link checks.
- **Read in review**: 25. No new state was added for a reload or a second Session.

## Out of scope

- More than one account, key or region per Connector.
- A read-only key, which New Relic does not document.
- Access-log and plain-text formats.
- Editing thresholds and intervals in the UI.
- The webhook receiver, which is on hold.
- Linux and Windows.
