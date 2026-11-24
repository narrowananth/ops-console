# CloudWatch logs as a third log source

**Status:** shipped; the pane's profile, region and sign-in (items 1 and 5) follow [one-click-log-sources](one-click-log-sources.md)
**Design:** Monitor and Integrations in `design/ops-console.html`. Departure: Integrations lists a fourteenth Connector whose pane has an AWS profile picker, a region picker and a log group picker in place of a folder field, and Alerts and Services carry a source label.

## Problem

A team whose services log to AWS CloudWatch cannot point Monitor at them through Datadog or the OpenTelemetry Log folder. The operator already signs in to AWS with the AWS CLI on this Mac, and the agent can query CloudWatch through AWS's own MCP server. The console should read the logs the way it reads Datadog's, with the daemon calling the CLI and no model turn, and let the agent use the MCP server to dig deeper during a Verification.

## Behavior

1. Integrations lists a fourteenth Connector, CloudWatch logs, after OpenTelemetry logs in the fixed order. Its pane has three choices: the AWS profile, the region and the log groups. The profile is a picker of the profiles on this Mac, `default` first, and the region is a picker of AWS regions that takes the profile's own region when it has one. A Find log groups button fills the log group picker from the account, with a filter box, and each picked group takes a Service name and an env.
2. The Service name defaults to the last path segment of the log group and the env defaults to `prod`. The operator may edit both. Two picked groups that give the same Service name and env are refused.
3. The console stores no AWS key. The credentials stay where the AWS CLI keeps them.
4. Connect needs the `aws` CLI and `uvx` on the PATH. When either is missing, Connect stops and the pane names the missing tool and the command that installs it (`brew install awscli`, `brew install uv`). The console installs neither.
5. The health check asks the AWS CLI who the profile is. A profile that answers reads connected. A non-zero answer for any reason reads needs auth, and a missing `aws` or no chosen profile reads down with the reason. Connect on a profile that is not signed in runs the CLI's browser sign-in: `aws sso login` for an Identity Center profile and `aws login` for any other, which needs AWS CLI 2.32.0 or later. An older CLI stops Connect, and the pane names its version and the command that updates it. A profile that is already signed in connects at once. While the sign-in waits, the pane offers Cancel, as the other Connectors do, and a second Connect changes nothing.
6. Connecting registers AWS's CloudWatch MCP server with Claude Code in every Claude account, started through `uvx` with the Connector's profile in its environment. Disconnect removes it. Changing the profile registers the server again with the new one.
7. A Scan reads every connected log source. A Scan the operator starts for one source reads only that source. CloudWatch logs runs on its own schedule from its own Check interval and daily scan time.
8. A Scan reads each picked log group with Logs Insights. A first query counts failing events per 10-minute bucket for each status code, method, path and message. A second query reads the newest failing events as Samples, at most 10,000 per log group. When the cap stops the read, the Scan says so.
9. The reader expects JSON log lines. Each field takes the first of these names present. Status code: `status`, `statusCode`, `status_code`, `http.status_code`. Method: `method`, `httpMethod`, `http.method`. Route: `route`, `path`, `resourcePath`, `url.path`. Level: `level`, `severity`, `log_level`. Message: `message`, `msg`. Time: the time CloudWatch recorded for the event. A line that is not JSON has none of these fields and is not read as a failure. The docs say so.
10. An event counts as failing when its status code is 400 or more, or its level is `error`, `critical`, `alert`, `emergency` or `fatal`, in any case.
11. The Scan groups failing events into Alerts with the same Severity rules, thresholds and Fingerprint masking as for the other sources. The Fingerprint of a CloudWatch Alert includes the source. Existing Datadog and OpenTelemetry Fingerprints do not change.
12. Each Sample keeps its message and fields with secret values and request body values redacted, as a Datadog Sample does.
13. The Scan's notes carry the bytes Logs Insights scanned for it, and any group a cap or a timeout left unread. A query that has not finished in 5 minutes is stopped, and the Scan reports its log group as not read. Stopping a Scan stops its running queries.
14. A throttled read fails the source with `rate_limited`. A signed-out profile, a missing log group or an unreachable AWS fails it with `upstream_failed`. A failure in one source does not stop another source's Scan.
15. Each Alert and Service shows its source, Datadog, OpenTelemetry, CloudWatch, Loki or New Relic, as a small label, and Monitor lists one source at a time through its source tabs ([monitor-source-tabs](monitor-source-tabs.md)).
16. A Service from CloudWatch finds its code by its name, as any Service does: an imported Repo of the same name, or a link the operator sets by hand.
17. A Verification or Fix of a CloudWatch Alert starts with a Recheck that reads the Alert's log group for the last hour. The Report's evidence section is headed "Log evidence".
18. The agent's brief for a CloudWatch Alert names the source, gives the Samples and the Alert's filter, and tells the agent to use no `pup` and no Datadog MCP Server, and to use the CloudWatch log tools when it needs more logs than the Samples.
19. The CloudWatch MCP Server starts for a Verification of a CloudWatch Alert and for a chat, and not for a Verification of another source's Alert, a Fix, a pull request job or a review. Of its tools the agent may use only the log tools: listing log groups, running a Logs Insights query, reading its results and cancelling it. The metric, PromQL and alarm tools are not allowed.
20. The agent's reach is what the AWS profile allows. The docs and the Connector pane tell the operator to use a profile with the `CloudWatchLogsReadOnlyAccess` policy. The console writes nothing to AWS, and an account is read-only whatever its env.
21. Several sources at once: Alerts from each stay in one Monitor list under All sources, and each source has a tab. A source that is down shows its reason on its tab and in the status sentence, and the others' Alerts still show.
22. Datadog and OpenTelemetry Connections, Services, Alerts, Scans and schedules are unaffected by the CloudWatch source. The migration keeps every existing row's source, and no Alert reopens or changes Severity.
23. A reload mid-Scan, two Sessions at once and an agent that fails mid-run behave as they do for a Datadog Alert.
24. Docs: the Connectors page lists sixteen Connectors and has a "CloudWatch logs" section with the IAM policy, the JSON log fields from 9 and a log line example. The data-flow page says the daemon calls the AWS CLI as the operator, the agent's MCP server calls AWS from this Mac, and CloudWatch events reach Anthropic only as Samples in a prompt or as the agent's tool output.

## Settled

- **Connector id and name**: `cloudwatch_logs`, shown as CloudWatch logs.
- **Service**: one picked log group is one Service. A Service is keyed by source, name and env. There is no discovery of every group.
- **Config**: `profile`, `region` and `log_groups` (each with `name`, `service` and `env`), then the fields every log source has: environments, daily scan time, default Check interval, the two Severity thresholds, ignored codes and reports folder. Only profile, region and log groups have fields in this change.
- **Reader**: Logs Insights, not `filter-log-events`. It aggregates in AWS and returns about 144 rows per group over 24 hours, where `filter-log-events` would page through every event and bucket on the Mac.
- **Sign-in**: the AWS CLI's own, per [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md). The health check treats any non-zero exit as signed out, since the CLI documents no exit code for an expired session.
- **MCP server**: AWS Labs' CloudWatch server, run with `uvx`. The profile name is not a secret, so it needs no Keychain item.
- **Window**: the Check interval of the Service. The Recheck reads the last hour.
- **Alert's stored query**: for CloudWatch, a JSON filter on log group, status code, method and path.
- **Retention**: unchanged. An open Alert no Scan has seen for 14 days resolves, per source.
- **Cost**: Logs Insights bills per GB scanned. The Scan's notes show the bytes, and the console sets no limit on them.
- **Region**: one region per Connector. A second region is a second Connector in a later spec.
- **Error codes**: `tool_missing` (422) for a missing `aws` or `uvx`, `log_group_not_found` (422) for a picked group the account does not have, and `duplicate_service` (422) for two picked groups with one Service name and env.
- **Database**: the `connector` `CHECK` on `services`, `scans` and `alerts` is dropped by rebuilding the three tables once. The code validates the value against the shared Connector ids, so a later source needs no migration.

## Not required

- **Plain-text, ALB and API Gateway access logs.** The reader takes JSON lines only. A mapping for access logs is a later spec.
- **Several regions or several profiles in one Connector.**
- **Checking the profile's IAM rights.** The console cannot read them, so it says what to grant and trusts the operator.
- **A limit on bytes scanned.** The operator sees the number in the Scan's notes.
- **Live tailing.** Logs are as fresh as the last Scan, and the Alert's Freshness says so.
- **Cross-source Alert merging.** The same failure seen by two sources stays two Alerts.
- **A guard on the agent against a profile with write rights.** The agent has no write tool for CloudWatch, and the profile's policy is the operator's.

## Safety

The agent's reach grows by one MCP server. It runs outside the Run sandbox, as Claude Code starts it, with the profile's AWS rights. The agent may call only its four log tools, which describe and query and change nothing. A run's own commands can read `~/.aws` and reach AWS, since the sandbox closes only the Keychain, the installed app and the git control files ([ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md)), so the tool list limits the server and the profile's policy is the bound on the agent (20). Nothing in the console writes to AWS, and a PROD account is read-only whatever the env. The daemon reads logs by calling the AWS CLI as the operator, as it calls `pup` and `gh`. Samples in the brief and the agent's tool output go to Anthropic's API as part of the run.

## Database

```sql
-- The `connector` CHECK on services, scans and alerts listed 'datadog' and 'otel_logs'.
-- SQLite cannot change a CHECK, so each table is rebuilt once without it, and the code validates the value.
-- services: UNIQUE (connector, name, env) stays.
-- alerts and scans: their columns and indexes stay as they are.
```

The migration rebuilds the three tables and copies every row, so each row keeps its `connector`, and the rows that point at them (Alerts, Samples, Reports, Rechecks, Scans) stay linked. The `connectors` table gains no column: its `config` JSON holds the new Connector's fields, and the migration seeds a `cloudwatch_logs` row with the defaults, off.

## API

### Common

- Every Alert, Service and Scan body already carries `connector`. Its value may be `"cloudwatch_logs"`. The endpoints that take `connector` accept it.
- The CloudWatch Connector's `config`:

```json
{
  "profile": "string, an AWS CLI profile name; empty until chosen",
  "region": "string, such as us-east-1; empty until chosen",
  "log_groups": [{ "name": "/ecs/shop-api", "service": "shop-api", "env": "prod" }],
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
| 422 | `tool_missing` | Connecting with no `aws` or no `uvx` on the PATH; the body names the tool and the install command |
| 422 | `log_group_not_found` | A picked log group the account does not have |
| 422 | `duplicate_service` | Two picked log groups with the same Service name and env |

### `GET /connectors/cloudwatch_logs/log-groups`

The log groups of a profile and region, for the picker. The optional query values `profile` and `region` name them, and the Connector's own are used when left out. Answers `{ data, meta }`; each item has `name`. It fails with `upstream_failed` when the profile is signed out, with `tool_missing` when `aws` is not on the PATH, and with `validation_failed` when no profile or region is known.

### `GET /connectors/cloudwatch_logs/profiles`

The AWS profiles on this Mac for the picker, `default` first and the rest A to Z. Each item has `name` and `region` (null when the profile names none). It fails with `tool_missing` when `aws` is not on the PATH.

### Connectors

The existing Connector endpoints serve `cloudwatch_logs`: list, read, connect (with `profile`, `region` and `log_groups`), cancel a waiting sign-in, disconnect and check. Disconnect removes the MCP server and leaves the AWS profile and the account untouched.

## UI

- **Integrations**: a Connector pane for CloudWatch logs with the profile picker, the region picker and the log group picker, each picked group showing its Service name and env as editable fields. States: not connected, signing in with Cancel, connected with the profile and region shown, needs auth with Reconnect, down with the reason (tool missing, log group not found, AWS unreachable), checking. The profile picker has a reading state and says Connect creates `default` when the Mac has no profile. The log group picker has loading, empty (the profile sees no groups) and error states. It follows the Connector panes of Integrations in the design.
- **Monitor**: the source label and the source tabs include CloudWatch. States: loading, empty, a source down (the other sources' Alerts still show, with its reason on its tab), a Scan that hit a cap or left a group unread (its detail says so, with the bytes scanned).
- **Report**: the evidence section reads "Log evidence".
- No PROD-specific state beyond the existing env tag display.

## Rejected

- **`filter-log-events` for the Scan**: it pages through every event and counts on the Mac, and its API allows about 10 calls a second.
- **AWS's managed MCP server**: its `call_aws` tool runs any AWS API, so only the IAM role would limit the agent. The CloudWatch server's tools describe and query.
- **`aws` through `run_integration`**: the agent reads logs through the MCP server's log tools. `aws` is on no `run_integration` list, so the console never runs it for the agent.
- **Auto-discovering every log group**: an account can hold hundreds, most of them not services, and each would be a Service and a Scan cost.
- **A tag or naming convention for env**: log groups carry neither, so the operator picks the env.
- **Keeping the `CHECK` and widening it**: SQLite cannot, and keeping it makes every new source a table rebuild.
- **MCP server only, no Scan reader**: it gives the agent logs and opens no Alert, so Monitor gains nothing.

## Glossary

- **Log group**: A CloudWatch Logs group the CloudWatch logs Connector reads. The operator picks it, and it is one Service.
- **Connector**: widened to "An outside service the operator signs in to, or a Log folder it reads, or an AWS profile it reads logs with. It holds the sign-in or the folder or the profile and registers the service's MCP Server when it has one."
- **Log source**: "Where a Scan reads failing requests from: Datadog, a Log folder, CloudWatch logs, Loki or New Relic."
- **Service**: "A deployed app the console watches in a log source, one per source, service name and env."
- **Scan**, **Sample**, **Recheck**: name the Alert's log source wherever they say Datadog or the Log folder.

## ADR

None. The `CHECK` rebuild is reversible, and the agent's MCP reach matches the Datadog server's.

## Seams

- **Backend + SQLite** (monitor test harness, a scripted fake `aws`): 7 to 14, 16, 17, 21 and 22. A Scan reads fixture Logs Insights answers: the field aliases from 9, failing by status and by level, the 10,000-event cap, a non-JSON group, redaction, Severity, Fingerprint with the source, a query that times out and one that is stopped, `rate_limited` and `upstream_failed`, several sources at once and one down, the Recheck, retention and Services keyed by source.
- **Backend + SQLite** (verification and fix tests, fake agent): 17 to 19. The brief for each source, the MCP scope per run purpose, the allowed tool list and the "Log evidence" heading.
- **Backend + SQLite** (connectors test): 1 to 6, 20. Connect, the health check states, config validation and the three 422 codes, the log group list, the MCP registration and its removal, and a changed profile.
- **Backend migration test** (existing): 22. A database with Datadog and OpenTelemetry rows survives the rebuild: every row, every child row, the unique key and no Alert reopened.
- **Browser** (Playwright e2e, `frontend/e2e/cloudwatch-connector.spec.ts` and the Monitor specs): 1, 2, 4, 5, 15 and 21. The Connector pane states, the pickers, a duplicate Service refused, the source label and tabs, and a source-down reason.
- **Node test** (site build test, existing): 24. The Connectors page count and the CloudWatch section, the data-flow lines, and the existing link and third-party checks.
- **Read in review**: 3 and 23. The console stores no AWS key, and no new state was added for a reload or a second Session.

## Out of scope

- Loki and New Relic logs, in [loki-log-source](loki-log-source.md) and [new-relic-log-source](new-relic-log-source.md).
- Access-log mappings for ALB and API Gateway, and plain-text logs.
- More than one region or profile per Connector.
- Editing thresholds and intervals in the UI.
- The webhook receiver, which is on hold.
- Linux and Windows.
