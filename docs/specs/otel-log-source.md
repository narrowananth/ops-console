# OpenTelemetry logs as a second log source

**Status:** shipped
**Design:** Monitor and Integrations in `design/ops-console.html`. Departure: Alerts and Services carry a small source label, and Integrations lists a thirteenth Connector with a Choose folder button in place of a sign-in.

## Problem

Datadog is the only place Monitor can read failing requests from. A team that ships its logs through an OpenTelemetry Collector, and has no Datadog, cannot use Monitor at all, and the roadmap's step 3 names generic OpenTelemetry logs as the source that reaches the most other tools. The console runs on the operator's Mac and keeps its server on `127.0.0.1` ([ADR 0003](../adr/0003-local-only-server.md)), so a receiver that other machines push to is out. The operator can point a Collector's file exporter at a folder on the Mac instead, and the console reads it.

## Behavior

1. Integrations lists a thirteenth Connector, OpenTelemetry logs, with one control: a Choose folder button that opens the macOS folder dialog. The chosen path is shown, and choosing a folder connects it. There is no sign-in and no typed path.
2. The Connector's health check reads connected when the folder exists and the console can read it. A folder that is missing or unreadable reads down with the reason, and Scans skip that source until the next check passes. An empty folder reads connected; its Scan finds nothing and says so.
3. A Scan reads every connected log source. A Scan the operator starts for one source reads only that source. Each source runs on its own schedule from its own Check interval and daily scan time.
4. The OpenTelemetry source reads the `.json` and `.jsonl` files directly in the Log folder, not its subfolders, newest first, as OTLP JSON log records the Collector's `file` exporter writes. Gzip and protobuf files are ignored.
5. A Scan reads only the records inside its time window, and at most 100 MB per Scan, newest files first. When the cap stops the read, the Scan says it read the newest 100 MB only.
6. A line that is not a valid log record is skipped. The Scan does not fail, and its detail says how many lines it skipped.
7. A record maps to a Scan's fields as follows. Service: `service.name`. Env: `deployment.environment.name`, else `deployment.environment`, else the env `no env`. Status code: `http.response.status_code`, else `http.status_code`. Method: `http.request.method`, else `http.method`. Route: `http.route`, else `url.path`. Message: the body. Time: `TimeUnixNano`. Version tag: `service.version`.
8. A record counts as failing when its status code is 400 or more, or its severity number is 17 or more.
9. The Scan groups failing records into Alerts with the same Severity rules, thresholds and Fingerprint masking as for Datadog. The Fingerprint of an OpenTelemetry Alert includes the source, so one Service name and env in two sources are two Services and two Alerts. Fingerprints of Datadog Alerts do not include it.
10. Each Sample keeps its message and attributes with secret values and request body values redacted, as a Datadog Sample does.
11. Each Alert and Service shows its source as a small label. Wherever Monitor said "Datadog" for what the Alert's own source reads, it names that source.
12. A Service from the OpenTelemetry source finds its code as any Service does ([monitor-source-tabs](monitor-source-tabs.md) 11), or the operator links a Repo by hand. There is no `git.repository_url` to read.
13. A Verification or Fix of an OpenTelemetry Alert starts with a Recheck that reads the Log folder for the last hour. The Report's evidence section is headed "Log evidence".
14. The agent's brief for an OpenTelemetry Alert names the source, gives the Samples and the filter text, and tells the agent to use no `pup` and no Datadog MCP Server. The agent has no log tool for the folder and says in the Report when it needed more logs than the Samples. A Datadog Alert's brief is unchanged apart from the wording of 11 and 13.
15. The agent gets no tool for the Log folder, and its brief says it cannot read it. The console reads the folder as the daemon, read only, and never writes in it.
16. Two sources at once: Alerts from each stay in one Monitor list, filterable by source. A failure in one source's read does not stop the other's Scan.
17. Datadog Connections, Services, Alerts, Scans and schedules are unchanged by the second source. Every row that predates it reads Datadog, and no Alert reopens or changes Severity.
18. A reload mid-Scan, two Sessions at once, and an agent that fails mid-run behave as they do for a Datadog Alert.
19. Docs: the Connectors page has an "OpenTelemetry logs" section with a Collector `file` exporter example. The data-flow page says the daemon reads the Log folder on the Mac and that its records reach Anthropic only as Samples in a prompt.

## Settled

- **Pull, not push**: the console reads a folder. A receiver on loopback needs a stable token that the per-start session token of ADR 0003 cannot give a Collector, and a receiver other machines reach is a tunnel. Both are later specs.
- **Connector, not a new concept**: the Glossary's Connector widens from "an outside service the operator signs in to" to include a local Log folder. Integrations stays the one place a source is connected.
- **Connector id and name**: `otel_logs`, shown as OpenTelemetry logs.
- **Config**: the Log folder, environments, default Check interval, daily scan time, the two Severity thresholds, ignored codes and reports folder. Only the Log folder has a control, as the thresholds have none for any source.
- **Read cap**: 100 MB per Scan, newest files first.
- **Window**: the Check interval of the Service, as for Datadog. The Recheck reads the last hour.
- **Identity**: a Service is keyed by source, name and env. An Alert's Fingerprint adds the source for OpenTelemetry only.
- **Alert's stored query**: `datadog_query` becomes `source_query`, with a `connector` column. For Datadog it is the query string; for OpenTelemetry it is a JSON filter on service, env, status code, method and path.
- **Retention**: unchanged. An open Alert no Scan has seen for 14 days resolves, per source.
- **Folder guard**: none. The console reads the files the operator pointed it at and does not follow or refuse symlinks.
- **Notes**: a Scan's cap and skipped-line notes ride in the Scan's `notes`, stored with its message.
- **No `service.name`**: a record with none is the Service `unknown_service`.
- **No `TimeUnixNano`**: a record with none uses `observedTimeUnixNano`.
- **Fatal**: OTLP severity 21 and above is `fatal` for OpenTelemetry only. Datadog's error levels do not change.
- **Names in the API**: the routes and types generic in shape are `monitor/log-services` and `LogService`, with a `connector` parameter.

## Not required

- **A push receiver or webhook** for logs, a tunnel, and a stable ingest token. Settled for a later spec with ADR 0003.
- **Reading subfolders, rotated gzip files or protobuf.** The operator configures the exporter to write plain JSON lines in one folder.
- **Editing thresholds, intervals and the daily scan time in the UI** for either source.
- **Live tailing.** Logs are as fresh as the last Scan; the Alert's Freshness says so.
- **Cross-source Alert merging.** The same failure seen by both sources stays two Alerts.
- **A log tool for the agent** over the folder.

## Safety

The agent gets no tool for the Log folder. The daemon reads the folder read only, as the operator. Samples in the brief go to Anthropic's API as part of the run, like any text the agent reads. Nothing here writes to a Connection, and an OpenTelemetry source has no PROD write path. An env named `prod` in the logs is read-only, like a Datadog one.

## Database

```sql
-- A Log source: which Connector a Service, an Alert or a Scan belongs to. The code validates the value.
ALTER TABLE services ADD COLUMN connector TEXT NOT NULL DEFAULT 'datadog';
-- The unique key is (connector, name, env).

ALTER TABLE alerts ADD COLUMN connector TEXT NOT NULL DEFAULT 'datadog';
-- Datadog: the query string. Every other source: a JSON filter {service, env, status, method, path}.
ALTER TABLE alerts RENAME COLUMN datadog_query TO source_query;

ALTER TABLE scans ADD COLUMN connector TEXT NOT NULL DEFAULT 'datadog';
```

Existing rows take `datadog` from the default. The `connectors` table gains no column: its `config` JSON holds the new Connector's fields, and the migration seeds the `otel_logs` row with the defaults, off.

## API

### Common

- Every Alert, Service and Scan body carries `connector`, a log source id such as `"datadog"` or `"otel_logs"`. `GET /monitor/envs`, `GET /monitor/status-codes` and `GET /alerts` take `connector` too.
- The Scan body gains `notes: string[]`: what the read did not cover in full, such as the cap or skipped lines.
- The Alert body carries `source_query`. The list item omits it.
- The OpenTelemetry Connector's `config`:

```json
{
  "folder": "string, absolute path of the Log folder; empty until chosen",
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
| 422 | `folder_not_found` | Connecting with a Log folder that does not exist or cannot be read |

### `GET /monitor/log-services`

Query parameters include `connector` (default `datadog`). Returns the Services that source has failing requests for, as before.

### `POST /monitor/scans`

The body gains an optional `connector`. Left out, the Scan reads every connected log source, and the answer is the first source's Scan.

### Connectors

The Connector endpoints serve `otel_logs`: list, read, connect (with the `folder`), disconnect and check. `POST /connectors/otel_logs/pick-folder` opens the folder dialog. Connect fails with `folder_not_found`. Disconnect leaves the folder and its files untouched.

## UI

- **Integrations**: a Connector pane for OpenTelemetry logs with a Choose folder button and the chosen path shown. States: not connected, connected with the folder shown, down with the reason (folder not found, not readable), checking. No sign-in button. It follows the Connector panes of Integrations in the design; the folder button replaces the sign-in step.
- **Monitor**: a source label on each Alert row and detail and on each Service. The list filters by source. States: loading, empty, a source down (the other source's Alerts still show, with a notice naming the source), a Scan that skipped lines or hit the read cap (its detail says so). Labels that said Datadog for the Alert's own source name that source.
- **Report**: the evidence section reads "Log evidence".
- No PROD-specific state beyond the existing env tag display.

## Rejected

- **A receiver on loopback for OTLP**: Collectors cannot hold the per-start session token, and a stable token amends ADR 0003. Later spec.
- **A webhook receiver now**: needs a tunnel or relay, which ADR 0003 forbids.
- **A "Monitor source" concept beside Connectors**: a second place to connect things, which Integrations exists to avoid.
- **One source at a time**: a switch in the UI and a migration back and forth.
- **Leaving `datadog_query` and adding `otel_filter`**: two nullable columns where one opaque query serves.
- **Giving the agent a tool over the Log folder**: a tool would need its own review of what it may read.
- **Rehashing Datadog Fingerprints with the source**: every Datadog Alert would reopen or duplicate.

## Glossary

- **Log folder**: The folder the OpenTelemetry logs Connector reads: OTLP JSON log files a Collector's `file` exporter writes on this Mac. The console reads it and never writes in it, and the agent never reads it.
- **Connector**: includes a Log folder it reads.
- **Service**: one per log source, service name and env.
- **Scan**: reads each connected source on its own schedule.
- **Sample**: "One log event kept on an Alert…".
- **Recheck**: "One read of the Alert's log source for its query over the last hour…".
- **Check interval**: "…in slots from the Connector's daily scan time."

## ADR

- **OpenTelemetry logs are read from a folder, not received**: the console pulls OTLP JSON files from a Log folder on the Mac and runs no ingest endpoint. Hard to reverse because Collectors, docs and Alerts are configured around it; surprising because OpenTelemetry users expect an OTLP endpoint; a real trade-off: it keeps ADR 0003 whole and needs no ingest token, and in return logs reach the console only as fresh as the Collector's file and the operator must run a Collector next to the Mac. A push receiver later needs its own ADR 0003 rewrite.

## Seams

- **Backend + SQLite** (monitor test harness, real files in a temp folder): 2 to 10, 12, 13, 15 to 17. A Scan reads fixture OTLP JSON lines: the mapping and legacy attribute names, failing by status and by severity number, window, the 100 MB cap, a malformed line skipped, redaction, Severity, Fingerprint with the source, two sources at once and one down, the health check states, the Recheck, retention, and existing rows reading as `datadog` with no Alert reopening.
- **Backend + SQLite** (verification and fix tests, fake agent): 13 and 14. The brief for each source, with no `pup` rule for an OpenTelemetry Alert, and the "Log evidence" heading.
- **Browser** (`frontend/e2e/otel-connector.spec.ts`): 1, 11 and 16. The Connector pane states, the source label and filter, and a source-down notice.
- **Node test** (site build test, existing): 19. The Connectors page count and the OpenTelemetry section, the data-flow line, and the existing link and third-party checks.
- **Read in review**: 18 is the existing Datadog flows; the reviewer checks no source-specific state was added.

## Out of scope

- The webhook receiver and a push receiver for OTLP, in their own spec with an ADR 0003 rewrite.
- Editing thresholds and intervals in the UI.
- Linux and Windows.
