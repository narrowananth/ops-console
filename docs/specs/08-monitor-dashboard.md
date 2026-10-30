# Monitor: Scans, Alerts, Verification, Review and Fix

**Status:** ready
**Design:** Monitor in `design/ops-console.html`: services and routes, the Alert card, Report, Review, and the Fix progress

## Problem

The operator wants failing routes found before customers report them, checked by the agent locally, and fixed only after they say so (ADR 0002). Datadog shows numbers; it does not remember that a failure was already seen, verified, dismissed or fixed. The console needs one Alert per failure that keeps its history across Scans and restarts, a Report still readable after Datadog drops the logs, and a Fix that can resume from the stage where it failed.

## Behavior

Scans and Alerts

1. A Scan reads every Service in the Datadog environments through `pup`, with no model turn. Services and Routes it finds are created; existing ones are kept.
2. A Scan that finds a failing Route creates one Alert holding severity, event count, `first_seen_at`, `last_seen_at`, the Datadog query and up to 25 Samples. An Alert with no matching Fingerprint starts as `open`.
3. A later Scan that fails the same Route with the same Fingerprint updates that Alert (event count, `last_seen_at`, Samples) and creates no second row.
4. Severity is `sev2` when the Route fails rapidly, `sev3` when it fails at the lower threshold with error-level logs, and `warn` otherwise. The thresholds come from the Datadog Connector's config (`04-settings-connectors`).
5. A resolved Alert reopens as a regression when a Scan sees its Route healthy and a later Scan sees it failing again, counting only events after `resolved_at`. `regression_count` goes up by one and its Reports stay.
6. A dismissed Alert whose Route keeps failing stays dismissed and keeps updating its counts. It reopens as a regression only after a healthy Scan followed by a failing one.
7. A Route marked `ignored` never raises an Alert. Its note is shown with the Route.
8. A Scan that hits a Datadog rate limit ends `rate_limited`; one that cannot reach Datadog ends `failed`. Both leave every Alert as it was and record an error code on the Scan.
9. Samples are redacted before they are written (`02-settings-agents`). An Alert keeps at most 25 Samples, newest first.
10. Two failures that differ only in ids, timestamps, IP addresses or counts share a Fingerprint. A different Route or error kind gives a different one.
11. Scans run on the schedule: `24h` at the Connector's `daily_scan_time`, `12h` at that time and 12 hours later, `6h` at that time and every 6 hours after. A Service's `check_interval` overrides the Connector's `default_interval`.
12. A Scan slot that passed while the daemon was stopped runs once at start, however many slots were missed.

Verification and Review

13. Starting a Verification on an `open` or `verified` Alert creates a Report in `running`, moves the Alert to `verifying`, and runs the agent in an agent session whose id the Report stores. Steps are stored as they arrive. `ready` moves the Alert to `verified`. A failed run sets the Report `failed` with its steps kept and returns the Alert to `open`.
14. A Service with no linked Repo still gets Alerts. Starting a Verification on it returns `service_unlinked`.
15. A second Verification on a `verifying` Alert is refused with `invalid_state`. Verifying a `verified` Alert creates Report version + 1; older versions stay readable.
16. An Alert in `verified` reports `waiting_since`, the time it entered that status (ADR 0002).
17. Confirming a `verified` Alert as `bug` or `improvement` creates a Review and a Fix and moves the Alert to `fixing`. Confirming in any other status is refused with `invalid_state`.
18. Confirming while the Jira Connector is not connected is refused with `connector_not_connected`. No Review or Fix is created.
19. Dismissing a `verified` Alert creates a Review with decision `dismissed` and moves the Alert to `dismissed`. Undo clears the Review and returns the Alert to `verified`.
20. In a `repo` Session linked to an Alert, a message whose whole text is `go`, `yes`, `start`, `do it` or `ok` (any case), sent while the Alert is `verified`, confirms it with the `kind` of the latest ready Report. In any other state it is an ordinary message.

Fix

21. A Fix runs in a `repo` Session linked to the Alert and moves through `ticket`, `branch`, `code`, `tests`, `pr`. The `ticket` stage creates a Jira issue through the Atlassian MCP server (issue type from the kind, priority High for `sev2` and Medium otherwise) with the Report attached, and names the branch `<KEY>-<report slug>`.
22. A failure at any stage leaves the Fix `failed` at that stage and the Alert in `fixing`. A retry continues from the failed stage; a ticket that already exists is not created twice.
23. When the PR opens, the Fix stores its number and URL, the Alert becomes `pr_open`, and the Jira issue moves to "In review" with the PR linked.
24. Every 5 minutes, and on each PR refresh, the daemon reads the PR of every `pr_open` Fix through the Git host adapter (`07-workspace`). Merged: the Alert becomes `resolved`. Closed unmerged: the Fix becomes `abandoned`, the Review is undone and the Alert returns to `verified`.

History and restarts

25. Every status change writes an `alert_events` row with the actor (`scan`, `agent` or `operator`) in the same transaction.
26. On daemon start, a `running` Scan becomes `failed` with `interrupted`, a `running` Report becomes `failed` with its Alert moved as in Behavior 13, and a `running` Fix becomes `failed` at its stage.

## Settled

- **Fixed reads and agent work** (ADR 0005): Scans call `pup` directly. Verification and Fix are agent runs. The Jira ticket goes through the Atlassian MCP server inside the Fix run.
- **Fingerprint**: hash of Service, Route and the error signature with numbers, ids, timestamps and IPs masked. One Alert per Fingerprint, `UNIQUE`.
- **Alert status**: `open`, `verifying`, `verified`, `fixing`, `pr_open`, `resolved`, `dismissed`. Stored on the Alert; `alert_events` records how it got there.
- **Event count**: sum of each Scan's error count. Scan windows equal the interval, so they do not overlap.
- **Alert sources**: `scan` is the only source written here; the others are kept for a later ingestion spec.
- **Report storage**: the database holds the Report body; `markdown_path` records where the Report file was written in the Connector's reports folder.
- **Review undo**: only a dismissal can be undone by the operator. A closed-unmerged PR undoes a confirmed Review.
- **Fix Session**: the Fix's `repo` Session carries `alert_id`, so the Workspace shows it next to the Alert.

## Not required

- **Exact counts under overlap**: two Scans of one Service at once can both add their counts.
- **Datadog retention**: Samples are kept and not refreshed.
- **Jira after abandon**: the issue is left as it is.

## Safety

- The agent creates a Jira ticket only after the operator confirms a Report, and moves it to "In review" only when it opens the PR.
- A Verification reads code and replays requests locally. It writes nothing outside the Repo's working tree. A PROD query needs the Connection's Access Level and, for a write, an Approval (`02-settings-agents`).
- The agent cannot change an Alert's status directly; only the Verification and Fix flows do.

## Database

```sql
CREATE TABLE services (
  id              TEXT PRIMARY KEY NOT NULL,
  name            TEXT NOT NULL,                 -- Datadog service name
  env             TEXT NOT NULL,                 -- Datadog env tag
  repo_id         TEXT REFERENCES repos (id) ON DELETE SET NULL,
  check_interval  TEXT,                          -- CheckInterval; null: Connector default
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (name, env)
) STRICT;

CREATE TABLE routes (
  id          TEXT PRIMARY KEY NOT NULL,
  service_id  TEXT NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  ignored     INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1)),
  note        TEXT,                              -- why it is ignored or expected to fail
  UNIQUE (service_id, method, path)
) STRICT;

CREATE TABLE scans (
  id             TEXT PRIMARY KEY NOT NULL,
  triggered_by   TEXT NOT NULL,                  -- ScanTrigger
  service_id     TEXT REFERENCES services (id) ON DELETE CASCADE,  -- null: every Service
  window_size    TEXT NOT NULL,                  -- CheckInterval
  status         TEXT NOT NULL DEFAULT 'running',  -- ScanStatus
  error_code     TEXT,                           -- 'interrupted' when the daemon stopped mid-Scan
  error_message  TEXT,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at    TEXT
) STRICT;
CREATE INDEX scans_started_idx ON scans (started_at DESC);
CREATE INDEX scans_service_idx ON scans (service_id, started_at DESC);

CREATE TABLE scan_route_results (
  scan_id      TEXT NOT NULL REFERENCES scans (id) ON DELETE CASCADE,
  route_id     TEXT NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  scanned_at   TEXT NOT NULL,
  error_count  INTEGER NOT NULL,
  state        TEXT NOT NULL,                    -- RouteState
  PRIMARY KEY (scan_id, route_id)
) STRICT;
CREATE INDEX scan_route_results_route_idx ON scan_route_results (route_id, scanned_at DESC);

CREATE TABLE alerts (
  id                TEXT PRIMARY KEY NOT NULL,
  route_id          TEXT NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  fingerprint       TEXT NOT NULL UNIQUE,
  source            TEXT NOT NULL DEFAULT 'scan',  -- AlertSource
  severity          TEXT NOT NULL,               -- Severity
  status            TEXT NOT NULL DEFAULT 'open',  -- AlertStatus
  title             TEXT NOT NULL,
  log_line          TEXT NOT NULL,               -- message of the newest Sample
  event_count       INTEGER NOT NULL,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  resolved_at       TEXT,
  regression_count  INTEGER NOT NULL DEFAULT 0,
  samples           TEXT NOT NULL DEFAULT '[]'
                    CHECK (json_valid(samples) AND json_type(samples) = 'array'
                           AND json_array_length(samples) <= 25),
  datadog_query     TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX alerts_status_idx ON alerts (status, last_seen_at DESC);
CREATE INDEX alerts_route_idx ON alerts (route_id);

CREATE TABLE alert_events (
  id        TEXT PRIMARY KEY NOT NULL,
  alert_id  TEXT NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,                       -- AlertEventKind
  actor     TEXT NOT NULL,                       -- AlertActor
  data      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX alert_events_alert_idx ON alert_events (alert_id, at);

CREATE TABLE reports (
  id              TEXT PRIMARY KEY NOT NULL,
  alert_id        TEXT NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',  -- RunStatus
  kind            TEXT,                          -- ReportKind; the agent's recommendation
  slug            TEXT,                          -- short name; ends the fix branch
  sdk_session_id  TEXT,                          -- the Verification's agent run; its transcript
  steps           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(steps)),  -- [{ kind, text }]
  replay          TEXT CHECK (json_valid(replay)),  -- { request, response }, redacted
  root_cause      TEXT,
  proposed_fix    TEXT,
  diff            TEXT CHECK (json_valid(diff)),  -- [{ sign, text }] when small enough to show
  markdown        TEXT,
  markdown_path   TEXT,                          -- set once the Report file is written
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at     TEXT,
  UNIQUE (alert_id, version)
) STRICT;
CREATE UNIQUE INDEX reports_one_running_idx ON reports (alert_id) WHERE status = 'running';

CREATE TABLE reviews (
  id          TEXT PRIMARY KEY NOT NULL,
  report_id   TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  decision    TEXT NOT NULL,                     -- ReviewDecision
  kind        TEXT,                              -- ReportKind; set when confirmed
  decided_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  undone_at   TEXT,
  CHECK ((decision = 'confirmed') = (kind IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX reviews_one_active_idx ON reviews (report_id) WHERE undone_at IS NULL;

ALTER TABLE sessions ADD COLUMN alert_id TEXT REFERENCES alerts (id) ON DELETE SET NULL;
ALTER TABLE action_log ADD COLUMN alert_id TEXT REFERENCES alerts (id) ON DELETE SET NULL;

CREATE TABLE fixes (
  id             TEXT PRIMARY KEY NOT NULL,
  review_id      TEXT NOT NULL UNIQUE REFERENCES reviews (id) ON DELETE CASCADE,
  session_id     TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  stage          TEXT NOT NULL DEFAULT 'ticket', -- FixStage
  status         TEXT NOT NULL DEFAULT 'running',  -- FixStatus
  jira_key       TEXT,                           -- set when the ticket stage ends
  jira_url       TEXT,
  branch         TEXT,                           -- '<jira_key>-<slug>', set with jira_key
  pr_number      INTEGER,                        -- in the Alert's Service's Repo
  pr_url         TEXT,
  error_message  TEXT,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at    TEXT
) STRICT;
```

| Enum | Values | Columns |
| ---- | ------ | ------- |
| `CheckInterval` | `24h`, `12h`, `6h` | `services.check_interval`, `scans.window_size` |
| `ScanTrigger` | `schedule`, `operator` | `scans.triggered_by` |
| `ScanStatus` | `running`, `ok`, `failed`, `rate_limited` | `scans.status` |
| `RouteState` | `ok`, `failing`, `rapid` | `scan_route_results.state` |
| `AlertSource` | `scan`, `datadog`, `sentry`, `slack` | `alerts.source` |
| `Severity` | `sev2`, `sev3`, `warn` | `alerts.severity` |
| `AlertStatus` | `open`, `verifying`, `verified`, `fixing`, `pr_open`, `resolved`, `dismissed` | `alerts.status` |
| `AlertEventKind` | `detected`, `regressed`, `verification_started`, `verified`, `verification_failed`, `confirmed`, `dismissed`, `undone`, `ticket_created`, `fix_advanced`, `pr_opened`, `resolved`, `abandoned` | `alert_events.kind` |
| `AlertActor` | `scan`, `agent`, `operator` | `alert_events.actor` |
| `RunStatus` | `running`, `ready`, `failed` | `reports.status` |
| `ReportKind` | `bug`, `improvement` | `reports.kind`, `reviews.kind` |
| `ReviewDecision` | `confirmed`, `dismissed` | `reviews.decision` |
| `FixStage` | `ticket`, `branch`, `code`, `tests`, `pr` | `fixes.stage` |
| `FixStatus` | `running`, `done`, `failed`, `abandoned` | `fixes.status` |

Migration of existing rows: none; existing Sessions and Action Log rows get a null `alert_id`.

## API

### Common

Errors added here:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `service_unlinked` | The Alert's Service has no Repo |

`Sample`, one entry of an Alert's `samples` (already redacted):

```json
{
  "id": "string",             // Datadog event id
  "timestamp": "string",      // ISO 8601
  "status": "string",         // error, warn, info
  "message": "string",
  "attributes": {},           // Datadog attributes, body values redacted
  "tags": ["string"]
}
```

`Alert`:

```json
{
  "id": "uuid",
  "route": { "id": "uuid", "method": "string", "path": "string" },
  "service": { "id": "uuid", "name": "string", "env": "string", "repo_id": "uuid | null" },
  "fingerprint": "string",
  "source": "AlertSource",
  "severity": "Severity",
  "status": "AlertStatus",
  "title": "string",
  "log_line": "string",
  "event_count": 0,
  "first_seen_at": "string",
  "last_seen_at": "string",
  "resolved_at": "string | null",
  "regression_count": 0,
  "waiting_since": "string | null",   // set while status is verified
  "datadog_query": "string",
  "samples": ["Sample"],              // detail only
  "latest_report": "Report | null",   // detail only
  "review": "Review | null",          // detail only
  "fix": "Fix | null"                 // detail only
}
```

`Report`: all `reports` columns except `sdk_session_id`, with `steps`, `replay` and `diff` as JSON. Step kinds: `step`, `command`, `output`, `error`, `warning`, `result`.
`Review`: `id`, `report_id`, `decision`, `kind`, `decided_at`, `undone_at`.
`Fix`: all `fixes` columns.

### Services, Routes and Scans

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /services` | query `env?` | Services with `routes`, per-Route `state`, `trend` (error counts from the last Scans), `open_alert_count`, `last_scan_at` |
| `PATCH /services/:id` | `{ repo_id?, check_interval? }` | Service |
| `PATCH /routes/:id` | `{ ignored?, note? }` | Route |
| `GET /scans` | query `service_id?` | newest first |
| `GET /scans/:id` | | Scan with `results: [{ route_id, error_count, state }]` |
| `POST /scans` | `{ service_id: "uuid \| null" }` | 202 Scan in `running`. Null scans every Service. Rate limits and failures land on the Scan row and `scan.finished` |

### Alerts, Reports, Review, Fix

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /alerts` | query `status?`, `service_id?`, `severity?` | `Alert[]` without detail fields, newest `last_seen_at` first |
| `GET /alerts/:id` | | `Alert` with detail fields |
| `GET /alerts/:id/events` | | `alert_events`, oldest first |
| `GET /alerts/:id/reports` | | every Report version |
| `GET /reports/:id` | | `Report` |
| `POST /alerts/:id/verifications` | | 202 `Report` in `running`; `invalid_state`, `service_unlinked` |
| `POST /alerts/:id/review` | `{ decision: "confirmed \| dismissed", kind: "ReportKind \| null" }` | `Review`, plus `Fix` on confirm. `kind` required for confirm, null for dismiss. `invalid_state`, `connector_not_connected` |
| `DELETE /alerts/:id/review` | | 204; undoes a dismissal; `invalid_state` otherwise |
| `GET /fixes/:id` | | `Fix` |
| `POST /fixes/:id/retry` | | 202; `invalid_state` unless `failed` |

### WebSocket events

All server to client.

| Event | Payload | When |
| ----- | ------- | ---- |
| `scan.started` | `{ scan_id, service_id }` | A Scan row is created |
| `scan.finished` | `{ scan_id, status, error_code }` | A Scan ends |
| `alert.detected` | `{ alert_id, severity, route }` | A Scan creates an Alert |
| `alert.updated` | `{ alert_id, event_count, last_seen_at }` | A Scan changes an Alert's counts |
| `alert.regressed` | `{ alert_id, regression_count }` | A resolved or dismissed Alert reopens |
| `verification.stepped` | `{ report_id, index, step: { kind, text } }` | Each Report step as it is stored |
| `alert.verified` | `{ alert_id, report_id, status: "ready \| failed" }` | A Verification ends |
| `alert.reviewed` | `{ alert_id, decision: "confirmed \| dismissed \| undone" }` | Confirm, dismiss, undo |
| `fix.advanced` | `{ fix_id, alert_id, stage, status, jira_key, pr_number }` | A Fix changes stage or status |
| `alert.resolved` | `{ alert_id }` | A merged PR resolves an Alert |

## UI

- Monitor list of Services and Routes with trend and state. Empty: "Connect Datadog in Settings › Connectors". Scan failure shows the error code with the last good Scan's time.
- Alert card: severity, counts, Samples (JSON and message toggle), events timeline, "waiting since" while `verified`, regression badge.
- Report panel: live steps while `running`, then root cause, proposed fix, diff and replay. Version picker when there are several.
- Review: confirm as bug or improvement, dismiss, undo dismiss. Confirm is disabled with the reason when Jira is not connected.
- Fix progress: the five stages, Jira key and PR link, retry on failure.

## Rejected

- **One Alert per Scan**: the same failure would come back as a new card every day and restart the "waiting since" clock. Sentry and PagerDuty group repeats under one key.
- **Only the Datadog query and trace ids**: nothing to read once Datadog drops the logs, and the Report's replay has no source.
- **Status derived from `alert_events`**: every list query would aggregate events.
- **Jira off, branch `fix/<slug>`**: breaks the link between Report, ticket and PR that the design shows.
- **Scans as agent runs**: a Scan is a fixed read; a model turn per Scan costs tokens and gives different answers for the same data (ADR 0005).

## Glossary

- **Fingerprint**: The identity of an Alert: Service, Route and the error signature with ids, numbers, timestamps and addresses masked. Two failures with the same Fingerprint belong to one Alert.
- **Regression**: A resolved or dismissed Alert that fails again after a healthy Scan. It reopens the same Alert.
- **Sample**: One Datadog log event kept on an Alert, with secret values and request body values redacted.
- **Ticket**: The Jira issue the agent creates when the operator confirms a Report. Its key starts the fix branch name.
- **Fix**: The work that follows a confirmed Review: ticket, branch, code change, tests and PR, run by the agent in one Session.

## Seams

- **Backend + SQLite, over HTTP** (Supertest, temporary data directory, fakes for `pup`, the agent runtime, the Atlassian MCP server and the Git host adapter, a fake clock for the scheduler): 1 to 9, 11, 12, 14 to 20, 22, 24, 26. Start-up cases close the app and open it again on the same data directory.
- **Backend + SQLite, over WebSocket**: 13, 21, 23, 25. Asserts the events and the `alert_events` rows written with each change.
- **Unit**: 10. Fingerprint masking.

## Out of scope

- Datadog and Jira Connector config, sign-in and `connector_not_connected`: `04-settings-connectors`.
- Agent runtime, redaction and the Action Log: `02-settings-agents`.
- The Git host adapter: `07-workspace`.
- Alerts from Datadog monitors, Sentry and Slack: a later ingestion spec.
