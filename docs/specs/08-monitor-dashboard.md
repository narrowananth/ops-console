# Monitor: Scans, Alerts, Verification, Review and Fix

**Status:** shipped
**Design:** Monitor in `design/ops-console.html`: services and routes, the Alert card, Report, Review, and the Fix progress

## Problem

The operator wants failing routes found before customers report them, checked by the agent locally, and fixed only after they say so (ADR 0002). Datadog shows numbers; it does not remember that a failure was already seen, verified, dismissed or fixed. The console needs one Alert per failure that keeps its history across Scans and restarts, a Report still readable after Datadog drops the logs, and a Fix that can resume from the stage where it failed.

## Behavior

Scans and Alerts

1. A Scan reads the failing requests of every Service over its window through `pup`, with no model turn: logs whose `@http.status_code` is 400 or more, in every env Datadog has logs for and the logs with no env tag. Logs with no status code are not read. The operator's Scan takes the window (`15m`, `1h`, `4h`, `24h`, `7d`), the HTTP status codes and, when they picked one, the Datadog Service names; it reads, raises and clears for those Services and codes only. A scheduled one reads every code from 400 up over its interval. Services and Routes it finds are created; existing ones are kept.
2. A Scan groups each Service's logs by HTTP status code, Route and masked message; a log that names no request path has no Route. Each group becomes one Alert holding its status code, severity, event count, `first_seen_at`, `last_seen_at`, the Datadog query and up to 25 Samples. An Alert with no matching Fingerprint starts as `open`.
3. A later Scan that sees the same Fingerprint updates that Alert (event count, `last_seen_at`, Samples) and creates no second row.
4. Severity is `high` when one 10-minute bucket of the group reaches the rapid threshold, `medium` when its errors per hour reach the failing threshold with error-level logs, and `low` otherwise. The thresholds come from the Datadog Connector's config (`04-settings-connectors`).
5. A resolved Alert reopens as a regression when a Scan that covers its Service does not see it, and a later Scan sees it again, counting only events after `resolved_at`. `regression_count` goes up by one and its Reports stay.
6. A dismissed Alert that keeps failing stays dismissed and keeps updating its counts. It reopens as a regression only after a Scan that does not see it followed by one that does.
7. A Route marked `ignored` never raises an Alert. Its note is shown with the Route.
8. A Scan that hits a Datadog rate limit ends `rate_limited`; one that cannot reach Datadog ends `failed`. Both leave every Alert as it was and record an error code on the Scan.
9. Samples are redacted before they are written (`02-settings-agents`). An Alert keeps at most 25 Samples, newest first.
10. Two failures that differ only in ids, timestamps, IP addresses or counts share a Fingerprint. A different Route, HTTP status code or error kind gives a different one.
11. Scans run on the schedule: `24h` at the Connector's `daily_scan_time`, `12h` at that time and 12 hours later, `6h` at that time and every 6 hours after. A Service's `check_interval` overrides the Connector's `default_interval`.
12. A Scan slot that passed while the daemon was stopped runs once at start, however many slots were missed.

Verification and Review

13. Starting a Verification on an `open` or `verified` Alert creates a Report in `running`, moves the Alert to `verifying`, and runs the agent in an agent session whose id the Report stores. Steps are stored as they arrive. `ready` moves the Alert to `verified`. A failed run sets the Report `failed` with its steps kept and returns the Alert to `open`.
14. A Verification runs in the Service's local Repo when it has one. With no Repo but a Git URL, it makes an anonymous Session (`07-workspace`), clones the URL into it, and runs there; a failed clone fails the Report with git's reason. A Service with neither still gets Alerts; starting a Verification on it returns `service_unlinked`.
15. A second Verification on a `verifying` Alert is refused with `invalid_state`. Verifying a `verified` Alert creates Report version + 1; older versions stay readable.
16. An Alert in `verified` reports `waiting_since`, the time it entered that status (ADR 0002).
17. Confirming a `verified` Alert as `bug` or `improvement` creates a Review and a Fix and moves the Alert to `fixing`. Confirming in any other status is refused with `invalid_state`.
18. Confirming does not need Jira. With the Jira Connector not connected, the Fix skips the ticket and names the branch `fix/<report slug>`.
19. Dismissing a `verified` Alert creates a Review with decision `dismissed` and moves the Alert to `dismissed`. Undo clears the Review and returns the Alert to `verified`.
20. In a Session linked to an Alert, a message whose whole text is `go`, `yes`, `start`, `do it` or `ok` (any case), sent while the Alert is `verified`, confirms it with the `kind` of the latest ready Report. In any other state it is an ordinary message.

Fix

21. A Fix runs in the Alert's Session, a `repo` Session or the anonymous one holding the clone, and moves through `ticket`, `branch`, `code`, `tests`, `pr`. With Jira connected, the `ticket` stage creates a Jira issue through the Atlassian MCP server (issue type from the kind, priority High for `high` and Medium otherwise) with the Report attached, and names the branch `<KEY>-<report slug>`. The `pr` stage commits, pushes the branch to `origin` and opens the pull request on its Git host: `gh`, `glab`, or the Bitbucket MCP server.
22. A failure at any stage leaves the Fix `failed` at that stage and the Alert in `fixing`. A retry continues from the failed stage; a ticket that already exists is not created twice.
23. When the PR opens, the Fix stores its number and URL, the Alert becomes `pr_open`, and a Jira issue, if there is one, moves to "In review" with the PR linked.
24. Every 5 minutes, and on each PR refresh, the daemon reads the PR of every `pr_open` Fix through the Git host adapter (`07-workspace`), using the Repo's remote or, for a clone, the Service's Git URL. Merged: the Alert becomes `resolved`. Closed unmerged: the Fix becomes `abandoned`, the Review is undone and the Alert returns to `verified`.

History and restarts

25. Every status change writes an `alert_events` row with the actor (`scan`, `agent` or `operator`) in the same transaction.
26. On daemon start, a `running` Scan becomes `failed` with `interrupted`, a `running` Report becomes `failed` with its Alert moved as in Behavior 13, and a `running` Fix becomes `failed` at its stage.

Logs, status codes, envs and where the code is

27. `GET /monitor/envs` lists the `env` tags with logs in Datadog over the last 7 days, the Connector's `environments` first and marked `configured`, then `no env`. `no env` stands for logs sent with no `env` tag; it reads them with `-env:*`, and their Services are stored with env `no env`.
31. `GET /monitor/datadog-services` lists the Services with failing requests in the given range, busiest first, with the envs they logged in and the count. It reads every env unless `envs` names some, and every code from 400 up unless `codes` names some. It reads one `pup logs aggregate` per env and keeps the answer 2 minutes.
32. `GET /monitor/status-codes` lists each HTTP status code from 400 up with requests in the given range, every env together, busiest first, with its count. It reads one `pup logs aggregate` by `@http.status_code` and keeps the answer 2 minutes.
33. An Alert stored before Scans read status codes has none. The Monitor's lists and the sidebar count leave it out while it is `open`; in any other status it stays listed.
28. A Scan stores the Git URL from the logs' `git.repository_url` tag on a Service that has none. The operator can set or clear it.
29. The Verification follows the log through the code end to end and answers with a Report whose Markdown has a summary, the evidence, the root cause with file and line, the impact, how to fix it and how to check the fix.
30. A Service with neither a Repo nor a Git URL gets its code found with no help, first match wins: an imported Repo of the same name; a git folder of that name next to an imported Repo, which is imported; a repository of that name on a connected Git host, under the Bitbucket workspace, the GitHub login and its organizations, then the owners of imported Repos. It runs once per Service after a Scan, and again on `POST /services/:id/code`, which answers with every place it looked. Nothing found leaves both empty.

## Settled

- **Fixed reads and agent work** (ADR 0005): Scans call `pup` directly. Verification and Fix are agent runs. The Jira ticket goes through the Atlassian MCP server inside the Fix run.
- **Fingerprint**: hash of Service, Route, HTTP status code and the error signature with numbers, ids, timestamps and IPs masked; an Alert with no status code hashes without it. One Alert per Fingerprint, `UNIQUE`.
- **Alert status**: `open`, `verifying`, `verified`, `fixing`, `pr_open`, `resolved`, `dismissed`. Stored on the Alert; `alert_events` records how it got there.
- **Event count**: sum of each Scan's error count. Scan windows equal the interval, so they do not overlap.
- **Scan reads**: per env, one `pup logs aggregate` by `service` over `@http.status_code:>=400` (or the picked codes), then one `pup logs search` per Service for its newest 1000 logs in the window. Groups, counts and the 10-minute peak come from those logs.
- **Log with no request**: its Alert hangs on the Service's blank Route (empty method and path), which the API shows as `route: null` and the Services list leaves out.
- **Message of a log**: its `message`, else `error.message`, `error.kind` or `logger.name`.
- **Healthy sighting**: a Scan that covers a Service writes `cleared_at` on each of its Alerts it did not see. Regression needs a `cleared_at` newer than the Alert's last sighting and `resolved_at`.
- **Finding the code**: names match without case or punctuation. Git hosts are asked with the operator's own tools: `gh repo view` for GitHub, `git ls-remote` over SSH with no prompt for Bitbucket and GitLab. Datadog's tag or attribute `git.repository_url` comes first, at the Scan.
- **Code source**: the local Repo wins over the Git URL. The URL is `github.com/owner/name` or any URL git clones; a bare host path is cloned over HTTPS with the operator's own git credentials and no prompt.
- **Alert sources**: `scan` is the only source written here; the others are kept for a later ingestion spec.
- **Report storage**: the database holds the Report body; `markdown_path` records where the Report file was written in the Connector's reports folder.
- **Review undo**: only a dismissal can be undone by the operator. A closed-unmerged PR undoes a confirmed Review.
- **Fix Session**: the Fix's `repo` Session carries `alert_id`, so the Workspace shows it next to the Alert.
- **Route identity**: ids in a path fold into `:id` (`/orders/1042` and `/orders/1043` are one Route) before a Route is stored or fingerprinted.
- **Datadog reads**: indexed storage only (Flex is not on every account).
- **Healthy Route**: a known Route absent from a Scan's logs gets an `ok` result and zero errors, for its trend.
- **Fingerprint signature**: the most common masked message among a Route's Samples; the newest wins a tie.
- **Severity**: `high` when one 10-minute bucket reaches `rapid_errors_per_10m`; `medium` when errors per hour over the window reach `failing_errors_per_hour` and the status code is 500 or more or a Sample has status `emergency`, `alert`, `critical` or `error`; else `low`.
- **Scan of some codes**: it clears only Alerts with those codes, and writes no healthy Route results: a Route quiet for the picked codes may still fail with others.
- **Schedule slots**: the daily time and every 6 hours after it are the grid. Each distinct interval runs once per slot of its own length, as one Scan of every Service on that interval. A slot that passed while Datadog is not connected is skipped.
- **Scan on demand**: `POST /scans` needs the Datadog Connector connected, and answers `connector_not_connected` otherwise.
- **Alert Session**: the first Verification makes one Session linked by `alert_id`: a `repo` Session on the Repo's current branch, or an anonymous Session with the clone. Every later Verification and Fix stage runs in it. `Alert` carries its id as `session_id`. A failed clone deletes that Session, so the next try clones again.
- **Verification steps**: each tool step and text block of the run is stored, redacted, and sent as `verification.stepped`.
- **Report file**: written to `reports_folder`, relative to the data folder. A failed write leaves `markdown_path` null and the Report ready.
- **Fix runs**: each stage is its own run in the Alert Session and ends with a JSON block (`ticket`: key and URL; `code`: summary; `tests`: passed; `pr`: number and URL). Any other answer fails the stage. The `branch` stage is the console's own checkout, with stash, from `07-workspace`.
- **`go` confirm**: the message starts no run. It answers 202 as an ordinary send would.
- **Merged PR**: a merged PR resolves the Alert with `resolved_at` set. A merged PR whose Fix is not `pr_open` is not looked at.

## Not required

- **Exact counts under overlap**: two Scans of one Service at once can both add their counts.
- **Datadog retention**: Samples are kept and not refreshed.
- **Jira after abandon**: the issue is left as it is.
- **Counts past 1000 logs**: a Service with more than 1000 failing requests in the window is grouped from its newest 1000, so counts and peaks are a floor.
- **Jira after a Fix without Jira**: connecting Jira later makes no ticket for a Fix already past `ticket`.
- **Clones**: an anonymous Session's folder stays after the Session is deleted.

## Safety

- The agent creates a Jira ticket only after the operator confirms a Report, and moves it to "In review" only when it opens the PR.
- The console clones a Service's Git URL only for a Verification the operator starts. The agent pushes only the Fix branch, opens the PR and never merges it (ADR 0002).
- A Verification reads code and replays requests locally. It writes nothing outside the Repo's working tree. A PROD query needs the Connection's Access Level and, for a write, an Approval (`02-settings-agents`).
- The agent cannot change an Alert's status directly; only the Verification and Fix flows do.

## Database

```sql
CREATE TABLE services (
  id              TEXT PRIMARY KEY NOT NULL,
  name            TEXT NOT NULL,                 -- Datadog service name
  env             TEXT NOT NULL,                 -- Datadog env tag
  repo_id         TEXT REFERENCES repos (id) ON DELETE SET NULL,
  repo_url        TEXT,                          -- Git URL of the code; from git.repository_url or the operator
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
  window_size    TEXT NOT NULL,                  -- ScanWindow
  envs           TEXT NOT NULL DEFAULT '[]',     -- JSON array of the Datadog envs read
  status_codes   TEXT NOT NULL DEFAULT '[]',     -- JSON array of the HTTP status codes read; empty: every code from 400 up
  services       TEXT,                           -- JSON array of Datadog Service names read; null: every Service
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
  cleared_at        TEXT,                        -- the latest Scan of its Service that did not see it
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
| `CheckInterval` | `24h`, `12h`, `6h` | `services.check_interval` |
| `ScanWindow` | `15m`, `1h`, `4h`, `6h`, `12h`, `24h`, `7d` | `scans.window_size` |
| `ScanTrigger` | `schedule`, `operator` | `scans.triggered_by` |
| `ScanStatus` | `running`, `ok`, `failed`, `rate_limited` | `scans.status` |
| `RouteState` | `ok`, `failing`, `rapid` | `scan_route_results.state` |
| `AlertSource` | `scan`, `datadog`, `sentry`, `slack` | `alerts.source` |
| `Severity` | `high`, `medium`, `low` | `alerts.severity` |
| `AlertStatus` | `open`, `verifying`, `verified`, `fixing`, `pr_open`, `resolved`, `dismissed` | `alerts.status` |
| `AlertEventKind` | `detected`, `regressed`, `verification_started`, `verified`, `verification_failed`, `confirmed`, `dismissed`, `undone`, `ticket_created`, `fix_advanced`, `pr_opened`, `resolved`, `abandoned` | `alert_events.kind` |
| `AlertActor` | `scan`, `agent`, `operator` | `alert_events.actor` |
| `RunStatus` | `running`, `ready`, `failed` | `reports.status` |
| `ReportKind` | `bug`, `improvement` | `reports.kind`, `reviews.kind` |
| `ReviewDecision` | `confirmed`, `dismissed` | `reviews.decision` |
| `FixStage` | `ticket`, `branch`, `code`, `tests`, `pr` | `fixes.stage` |
| `FixStatus` | `running`, `done`, `failed`, `abandoned` | `fixes.status` |

Migration of existing rows: existing Sessions and Action Log rows get a null `alert_id`. Severities move `sev2` to `high`, `sev3` to `medium` and `warn` to `low`; existing Scans get `envs` `[]` and a null `services`.

## API

### Common

Errors added here:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `service_unlinked` | The Alert's Service has neither a Repo nor a Git URL |

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
  "route": { "id": "uuid", "method": "string", "path": "string" } | null,  // null: a log with no request
  "service": { "id": "uuid", "name": "string", "env": "string", "repo_id": "uuid | null", "repo_url": "string | null" },
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
| `PATCH /services/:id` | `{ repo_id?, repo_url?, check_interval? }` | Service. `repo_url` must look like a Git URL |
| `POST /services/:id/code` | | `{ service, found: "repo \| url \| null", tried: string[] }`, after looking (Behavior 30) |
| `PATCH /routes/:id` | `{ ignored?, note? }` | Route |
| `GET /scans` | query `service_id?` | newest first |
| `GET /scans/:id` | | Scan with `results: [{ route_id, error_count, state }]` |
| `POST /scans` | `{ service_id: "uuid \| null", window?: ScanWindow, envs?: string[], services?: string[], status_codes?: number[] }` | 202 Scan in `running`, with `envs`, `services` and `status_codes`. Null `service_id` and no `services` scans every Service. `window` defaults to the Connector's `default_interval`, `envs` to every env, `status_codes` to every code from 400 up; a single Service scans its own env. Rate limits and failures land on the Scan row and `scan.finished` |
| `GET /monitor/envs` | | `[{ name, configured }]`, the Connector's envs first, `no env` last |
| `GET /monitor/datadog-services?window=&envs=a,b&codes=401,500` | | `[{ name, envs, errors }]`, busiest first; `envs` and `codes` optional |
| `GET /monitor/status-codes?window=` | | `[{ code, count }]`, busiest first |

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
| `alert.detected` | `{ alert_id, severity, route \| null }` | A Scan creates an Alert |
| `alert.updated` | `{ alert_id, event_count, last_seen_at }` | A Scan changes an Alert's counts |
| `alert.regressed` | `{ alert_id, regression_count }` | A resolved or dismissed Alert reopens |
| `verification.stepped` | `{ report_id, index, step: { kind, text } }` | Each Report step as it is stored |
| `alert.verified` | `{ alert_id, report_id, status: "ready \| failed" }` | A Verification ends |
| `alert.reviewed` | `{ alert_id, decision: "confirmed \| dismissed \| undone" }` | Confirm, dismiss, undo |
| `fix.advanced` | `{ fix_id, alert_id, stage, status, jira_key, pr_number }` | A Fix changes stage or status |
| `alert.resolved` | `{ alert_id }` | A merged PR resolves an Alert |

## UI

- Monitor, first column, Services: the range (`15m` to `7d`) and a Status field that opens the codes from Behavior 32 with their names and counts, under 4xx, 5xx and other, each class with its own checkbox, and "Every code from 400 up" (the default) on top; both are remembered in the browser. There is no env pick: every env is read. Under them a filter, "All Services", and the Datadog Services from Behavior 31 as rows, A→Z with the Services that have open Alerts but no failing requests in the range among them at 0: name, count, a bar of the count against the busiest, and open Alerts per tier. Each row has a checkbox to tick it for a Scan; the one on "All Services" ticks or unticks every row shown. Ticking does not change the logs shown; picking a row does. At the bottom, Scan: the ticked Services, or else the picked one, or else every listed one, over the range and codes, with Untick to clear the ticks; then the last Scan's window, Services and codes.
- Monitor, second column, logs of the picked Service or all: tabs All, High, Medium, Low with counts, and the logs as rows: tier, Service when all are shown, status code (amber for 4xx, red for 5xx and above), count, last seen, message, Route. Only Alerts with a picked code show. Closed Alerts show only when asked. The rows come 100 at a time, with "Show 100 more" and how many of the total are drawn; a new Service, tab, Closed or code pick starts at 100 again, and the open Alert stays drawn. Empty: "Connect Datadog in Integrations". Scan failure shows the error code with the last good Scan's time.
- A button that starts the agent (Verify, Fix, Retry) greys out with a spinner from the click until the run's status is back; Verify stays greyed, reading "Agent verifying…", while the Alert is `verifying`.
- Alert card: tier, status, Service, env and Route (or "no HTTP route"), counts, the log line, Samples (JSON and message toggle), events timeline, "waiting since" while `verified`, regression badge, and Ignore this Route.
- Code: the local Repo picker and the Git URL field. With neither, the card looks for the code by itself, then lists where it looked, with Look again. Still nothing: Verify is disabled and the card says to give one.
- Report panel: live steps while `running`; when ready, the Report Markdown drawn, then the diff, replay and steps folded, and where the file was saved. Version picker when there are several.
- Review: Fix with agent (the Report's kind), Fix as the other kind, dismiss, undo dismiss. A line says where the Fix runs and whether a Jira ticket comes first.
- Fix progress: the five stages, the ticket marked "no Jira" when skipped, the branch, Jira key, PR link, a link to the Session in Workspace, and retry on failure.

## Rejected

- **One Alert per Scan**: the same failure would come back as a new card every day and restart the "waiting since" clock. Sentry and PagerDuty group repeats under one key.
- **Only the Datadog query and trace ids**: nothing to read once Datadog drops the logs, and the Report's replay has no source.
- **Status derived from `alert_events`**: every list query would aggregate events.
- **Jira required for a Fix**: an operator without Jira could not fix anything. With Jira the branch still carries the key, so Report, ticket and PR stay linked.
- **Route aggregates only**: logs from workers and jobs carry no method or path, so a Scan never saw them.
- **Agent searches the Git hosts for the code**: a model guess can pick the wrong repository. The finder asks only for the exact name, and the operator's choice overrides it.
- **Scans as agent runs**: a Scan is a fixed read; a model turn per Scan costs tokens and gives different answers for the same data (ADR 0005).

## Glossary

- **Fingerprint**: The identity of an Alert: Service, Route, HTTP status code and the error signature with ids, numbers, timestamps and addresses masked. Two failures with the same Fingerprint belong to one Alert.
- **Regression**: A resolved or dismissed Alert that fails again after a healthy Scan. It reopens the same Alert.
- **Sample**: One Datadog log event kept on an Alert, with secret values and request body values redacted.
- **Ticket**: The Jira issue the agent creates when the operator confirms a Report. Its key starts the fix branch name.
- **Fix**: The work that follows a confirmed Review: ticket (with Jira), branch, code change, tests, push and PR, run by the agent in one Session.
- **Severity**: An Alert's tier, `high`, `medium` or `low`, from how fast its logs come in.

## Seams

- **Backend + SQLite, over HTTP** (Supertest, temporary data directory, fakes for `pup`, the agent runtime, the Atlassian MCP server and the Git host adapter, a fake clock for the scheduler; a local git repository as the clone source): 1 to 9, 11, 12, 14 to 20, 22, 24, 26 to 30. Start-up cases close the app and open it again on the same data directory.
- **Backend + SQLite, over WebSocket**: 13, 21, 23, 25. Asserts the events and the `alert_events` rows written with each change.
- **Unit**: 10, and the log grouping behind 2 and 4. Fingerprint masking, groups by Route and message, the 10-minute peak, the Git URL tag.

## Out of scope

- Datadog and Jira Connector config, sign-in and `connector_not_connected`: `04-settings-connectors`.
- Agent runtime, redaction and the Action Log: `02-settings-agents`.
- The Git host adapter: `07-workspace`.
- Alerts from Datadog monitors, Sentry and Slack: a later ingestion spec.
