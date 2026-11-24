# Monitor: Scans, Alerts, Verification, Review and Fix

**Status:** shipped
**Design:** Monitor screen in `design/monitor-redesign.html` ([monitor-source-tabs](monitor-source-tabs.md)); the Report, Review and Fix progress in `design/ops-console.html`

## Problem

The operator wants failing routes found before customers report them, checked by the agent locally, and fixed only after they say so (ADR 0002). A log source shows numbers; it does not remember that a failure was already seen, verified, dismissed or fixed. The console needs one Alert per failure that keeps its history across Scans and restarts, a Report still readable after the source drops the logs, and a Fix that can resume from the stage where it failed.

## Behavior

Scans and Alerts

1. A Scan reads the failing requests of one log source over its window with no model turn: Datadog through `pup`; the OpenTelemetry Log folder, CloudWatch logs, Loki and New Relic as [otel-log-source](otel-log-source.md), [cloudwatch-log-source](cloudwatch-log-source.md), [loki-log-source](loki-log-source.md) and [new-relic-log-source](new-relic-log-source.md) set out. Datadog reads logs whose `@http.status_code` is 400 or more and skips a log with no status code; the other sources also read a log at error level or above. It reads every env the source has logs for and the logs with no env tag. The operator's Scan takes the window (any `ScanWindow`; the Monitor offers `15m`, `1h`, `4h`, `24h` and `7d`), the HTTP status codes and, when they picked some, the Service names; it reads, raises and clears for those Services and codes only. It reads the source the operator picked, else every connected source, and stores one Scan per source. A scheduled one reads every code over its interval. Services and Routes it finds are created; existing ones are kept. A Service is one source, name and env.
1a. A Scan of one stored Service (`service_id`) reads only that Service, in its own source and env, over the window asked for, else the Service's `check_interval`, else the source Connector's `default_interval`. A `connector` that names another source than the Service's is refused with `validation_failed`.
2. A Scan groups each Service's logs by HTTP status code, Route and masked message; a log that names no request path has no Route. Each group becomes one Alert holding its log source, status code (none for a log read by level alone), severity, event count, `first_seen_at`, `last_seen_at`, the source query and up to 25 Samples. An Alert with no matching Fingerprint starts as `open`.
3. A later Scan that sees the same Fingerprint updates that Alert (event count, `last_seen_at`, Samples) and creates no second row.
4. Severity is `high` when one 10-minute bucket of the group reaches the rapid threshold, `medium` when its errors per hour reach the failing threshold and the status code is 500 or more or a Sample is at error level, and `low` otherwise. The thresholds come from the log source Connector's config (`04-settings-connectors`).
5. A resolved Alert reopens as a regression when a Scan that covers its Service does not see it, and a later Scan sees it again. Its event count starts again, counting only events after `resolved_at`; its Samples keep only the logs after `resolved_at`; `resolved_at` is cleared, `regression_count` goes up by one and its Reports stay. A resolved Alert that a Scan sees with no healthy Scan between stays `resolved`, its counts unchanged.
5a. An open Alert that no Scan has seen for 14 days is resolved by the console: `resolved_at` is its last sighting, `cleared_at` is the time of the pass, and an `auto_resolved` event is written with the actor `scan`. The next Scan that sees it reopens it as a regression (Behavior 5). The pass runs once a day and after a Scan, at most once an hour.
6. A dismissed Alert that keeps failing stays dismissed and keeps updating its counts. It reopens as a regression only after a Scan that does not see it followed by one that does. Reopening undoes the dismissal Review.
7. A Route marked `ignored` never raises an Alert. Its note is shown with the Route.
7a. The log source Connector's ignore rules (`04-settings-connectors`) work the same way: a `route` rule's glob on the path raises no Alert for a matching Route, and a `status_class` rule (`4xx`) leaves those codes out of every Scan's read.
8. A Scan that hits a rate limit ends `rate_limited`; one that cannot reach the source ends `failed`. Both leave every Alert as it was and record an error code (`rate_limited` or `upstream_failed`) and a message on the Scan.
8a. A Scan that ends `ok` can carry notes: what it did not read in full, such as lines it skipped or a read the size cap stopped. They are kept on the Scan as `notes` and the Monitor shows them (Behavior 36).
9. Samples are redacted before they are written (`02-settings-agents`). An Alert keeps at most 25 Samples, newest first.
10. Two failures that differ only in ids, timestamps, IP addresses or counts share a Fingerprint. A different Route, HTTP status code or error kind gives a different one. Every source but Datadog adds its own name to the Fingerprint, so one Service name and env in two sources are two Services and two Alerts.
11. Scans run on the schedule of each log source, from its Connector's `daily_scan_time`: `24h` at that time, `12h` at that time and 12 hours later, `6h` at that time and every 6 hours after. A Service's `check_interval` overrides the Connector's `default_interval`. A source that is down or not connected is skipped, and one that fails does not stop the others.
12. A Scan slot that passed while the daemon was stopped runs once at start, however many slots were missed. The catch-up waits in the start-up queue, which opens 3 seconds after the daemon's port opens and runs two tasks at a time with a second of rest after each, so the page's first requests are answered first.

Verification and Review

13. Starting a Verification on an `open` or `verified` Alert creates a Report in `running` holding a copy of the Verify Playbook ([agent-playbooks](agent-playbooks.md)), moves the Alert to `verifying`, and answers 202; the work goes on in the background. The agent runs in the Alert Session, in a scratch copy of the code ([prod-parity-check](prod-parity-check.md)): first the Recheck, then the Playbook's steps one agent turn each, then the console's closing turn that writes the Report. Steps are stored as they arrive. `ready` moves the Alert to `verified`. A failed run sets the Report `failed` with its steps kept and returns the Alert to `open`.
13a. `POST /reports/:id/retry` runs a failed Report again from its failed step, in the same scratch copy and into the same version: the Report is `running` and the Alert `verifying` again, and its `started_at` starts over. With `skip: true` the failed step is first marked skipped by the operator. Only the newest Report, with its scratch copy still on disk, can retry; any other is refused with `invalid_state`. A ready Report's scratch copy is removed before the Alert reads `verified`, and so is an older Report's when a new Verification starts.
14. A Verification works from the Service's local Repo when it has one. With no Repo but a Git URL, it makes an anonymous Session (`07-workspace`), clones the URL into it, and works from that clone; a failed clone fails the Report with git's reason and deletes that Session. A Service with neither still gets Alerts; starting a Verification on it returns `service_unlinked` before any Report exists.
15. A second Verification on a `verifying` Alert is refused with `invalid_state`. Verifying a `verified` Alert creates Report version + 1; older versions stay readable.
16. An Alert in `verified` reports `waiting_since`, the time it entered that status (ADR 0002).
17. Confirming a `verified` Alert as `bug` or `improvement` creates a Review and a Fix and moves the Alert to `fixing`. Confirming in any other status is refused with `invalid_state`.
18. Confirming does not need Jira. The Fix makes a ticket only when its Playbook's Jira ticket switch is on (off on the built-in); off, it skips the ticket with "the Fix Playbook makes no Jira ticket". With the switch on and the Jira Connector not connected, the Fix skips the ticket and names the branch `fix/<report slug>`. With Jira connected but the ticket not made (the Atlassian MCP server down, an answer the console cannot read), the Fix does the same and goes on, and keeps why; the ticket stage shows it. Only the operator's Stop fails the ticket stage.
19. Dismissing a `verified` Alert creates a Review with decision `dismissed` and moves the Alert to `dismissed`. Undo clears the Review and returns the Alert to `verified`.
20. In a Session linked to an Alert, a message whose whole text is `go`, `yes`, `start`, `do it` or `ok` (any case), sent while the Alert is `verified`, confirms it with the `kind` of the latest ready Report. In any other state it is an ordinary message.

Fix

21. A Fix runs in the Alert's Session, a `repo` Session or the anonymous one holding the clone, and moves through `ticket`, `branch`, `steps`, `pr`, holding a copy of the Fix Playbook taken when the Review was confirmed. With the Playbook's Jira ticket switch on and Jira connected, `ticket` creates a Jira issue through the Atlassian MCP server (issue type from the kind, priority High for `high` and Medium otherwise) with the Report attached, and names the branch `<KEY>-<report slug>`. `branch` checks the branch out in the Session, cut from the newest commit of the first branch the Playbook's Branch field names that origin has, else the Repo's default branch. `steps` runs the Playbook's steps one agent turn each. In `pr` the agent commits the work and writes the pull request's description; the console pushes the branch to `origin` and opens the pull request on its Git host: `gh`, `glab` or `bkt`.
22. A failure at any stage leaves the Fix `failed` at that stage and the Alert in `fixing`. A retry continues from the failed stage. In `steps` it runs the failed step again and every step after it, and `skip: true` on `POST /fixes/:id/retry` first marks the failed step skipped; Skip is refused with `invalid_state` at any other stage. A ticket that already exists is not created twice, and a pull request that is already open is not opened twice.
23. When the PR opens, the Fix stores its number and URL, the Alert becomes `pr_open`, and a Jira issue, if there is one, moves to "In review" with the PR linked.
24. Every 5 minutes, and on each PR refresh, the daemon reads the PR of every `pr_open` Fix through the Git host adapter (`07-workspace`), using the Repo's remote or, for a clone, the Service's Git URL. Merged: the Alert becomes `resolved`. Closed unmerged: the Fix becomes `abandoned`, the Review is undone and the Alert returns to `verified`.

History and restarts

25. Every status change writes an `alert_events` row with the actor (`scan`, `agent` or `operator`) in the same transaction.
26. On daemon start, a `running` Scan becomes `failed` with `interrupted`, a `running` Report becomes `failed` with `interrupted`, its steps kept and its Alert moved as in Behavior 13, and a `running` Fix becomes `failed` at its stage. A Playbook step that was running reads failed (`agent-playbooks`). Scratch copies stay only for failed Reports.

Logs, status codes, envs and where the code is

27. `GET /monitor/envs` lists the `env` tags a log source has logs for over the last 7 days, the Connector's `environments` first and marked `configured`, then `no env`; `connector` picks the source, Datadog when left out. `no env` stands for logs sent with no `env` tag; Datadog reads them with `-env:*`, and their Services are stored with env `no env`. The list is kept 10 minutes per source.
28. A Datadog Scan stores the Git URL from the logs' `git.repository_url` tag on a Service that has none, when it looks like a Git host URL. The other sources carry none. The operator can set or clear it with `PATCH /services/:id`.
29. The Verification follows the log through the code and answers with a Report: its kind, a slug, the root cause with file and line, the proposed fix, an optional replay and diff, and Markdown in the sections the closing turn lists (issue summary, log evidence, affected services, root cause, code-level findings, timeline, blast radius, consumer analysis, database findings, external dependency findings, reproduction and validation, existing PR verification, recommended stable fix, regression risks and test plan, prod parity, final conclusion). Each finding is marked verified, mocked or unverified.
29a. The agent's brief names the Alert's log source and what it may read it with. Datadog follows the Playbook's rules (`pup` and the Datadog MCP Server). The Log folder has no tool, and the brief says so. CloudWatch has the log tools of the CloudWatch MCP Server, Loki the Grafana MCP Server's Loki tools, and New Relic the New Relic MCP Server's NRQL tool, or the console's read-only `query_new_relic` tool when the Connector reads with a User API key. An Alert of any source but Datadog is told to use no `pup` and no Datadog MCP Server.
30. A Service with neither a Repo nor a Git URL gets its code found with no help, first match wins: an imported Repo of the same name; a git folder of that name next to an imported Repo, which is imported; the imported Repo whose tracked source holds the Service's Route paths (up to eight, cut before any dynamic segment, tests and docs left out; the Repo holding the most Routes wins, and a tie stays unlinked unless exactly one tied Repo carries the Service's name); a repository of that name on a connected Git host, under the Bitbucket workspace, the GitHub login and its organizations, then the owners of imported Repos. A Service with a Git URL and no Repo goes through the first three steps and keeps its URL when none matches. It runs in the background after a Scan for each Service with no code that was not looked for in the last week, two at a time, and again on `POST /services/:id/code`, which answers with every place it looked. Nothing found leaves both empty.
31. `GET /monitor/log-services` lists the Services of one log source (`connector`, Datadog when left out) with failing requests in the given range, busiest first, with the envs they logged in and the count. It reads every env unless `envs` names some, and every code from 400 up unless `codes` names some. Datadog reads one `pup logs aggregate` per env. The answer is kept 2 minutes.
32. `GET /monitor/status-codes` lists each HTTP status code from 400 up with requests in the given range for one log source (`connector`, Datadog when left out), every env together, busiest first, with its count. Datadog reads one `pup logs aggregate` by `@http.status_code`. The answer is kept 2 minutes.
33. An Alert stored before Scans read status codes has none. The Monitor's table, the Services menu and the sidebar count leave it out while it is `open`; in any other status it stays listed. In the Monitor's table and menu, an Alert with a code shows when its code is picked, or every code is; the sidebar counts every code.

The Monitor screen

34. The Scan button scans the ticked Services, else the picked Service, else every Service listed, over the picked range and codes, in the source the open tab names, else in every connected source. A ticked Service missing from the list stays ticked but is not scanned. While a Scan of a source in view is `running`, the button is disabled and reads "Scanning…", with a Stop button beside it. Stop calls `POST /scans/:id/cancel` for each running Scan in view: the read ends, nothing it read is kept, and the Scan ends `cancelled` (204; `invalid_state` when it is not running).
35. The table lists the Alerts of the picked source and Service, or of every one, with a picked code. `resolved` and `dismissed` Alerts show only with Closed ticked; they are read 50 at a time (`GET /alerts?scope=closed`), with "Load older resolved and dismissed" for the next page. The severity switch starts at "Needs attention" (High and Medium); Low Alerts wait behind a row. Rows go highest tier first, newest sighting first within a tier, and are drawn 100 at a time; the open Alert stays drawn even past the rows shown.
36. The status sentence in the Monitor header says how the newest Scan of each source in view ended. A Scan that ended `rate_limited`, `failed` or `cancelled` shows in red with the time of that source's last `ok` Scan, or "No good Scan yet."; a source that is down, an `ok` Scan's notes, and a Service whose open Alerts no Scan has read for two Check intervals show there too, with the reasons one click away.
37. The picked Service and Alert are kept in the address, and the Monitor's other choices in the browser, as `persist-selections-and-runs` Behaviors 1 to 11 set out.
38. Cancel Fix, on a `running` or `failed` Fix with no pull request, asks first. Confirmed, it stops the Fix's run, and no further stage, step or agent turn starts. When the Session's checkout is on the Fix branch, its uncommitted changes go on the git stash and the source branch (the first branch the Playbook's Branch field names that origin has, else the Repo's default branch) is checked out. The Fix branch is deleted. The Fix becomes `abandoned`, the Review is undone, and the Alert returns to `verified` with an `abandoned` event, so the Review actions show again. A Jira ticket is left as it is. Cancel is refused while the Fix is already being cancelled, and on a Fix with a pull request, which is abandoned by closing the pull request (Behavior 24).

Scans kept and Alerts listed

39. Scans, their Route results and Alert events older than 30 days are deleted in small batches, once a day and after a Scan (at most hourly). The newest `ok` Scan that read each Service, and the newest one that read it for every status code, stay, so Freshness and each Route's state hold. The events of an Alert in `verifying`, `verified`, `fixing` or `pr_open` stay. The Action Log is never touched.
40. `GET /alerts` lists every Alert not `resolved` or `dismissed`, newest sighting first, with no Samples and no source query and a `log_line` cut to 300 characters; `GET /alerts/:id` has them whole. `scope=closed` lists the resolved and dismissed ones a page at a time (`limit`, default 50, at most 200; `cursor` from `meta.next_cursor`). `GET /alerts/summary` answers `{ open }`, the count behind the sidebar badge (Behavior 33). Each Alert carries `last_scanned_at`, `scan_overdue` and `awaiting_prod_check` ([prod-parity-check](prod-parity-check.md)).

## Settled

- **Fixed reads and agent work** (ADR 0005): each source's reader runs with no agent turn. Verification and Fix are agent runs. The Jira ticket goes through the Atlassian MCP server inside the Fix run.
- **Fingerprint**: hash of Service, Route, HTTP status code and the error signature with numbers, ids, timestamps and IPs masked, and the log source for every source but Datadog; an Alert with no status code hashes without it. One Alert per Fingerprint, `UNIQUE`.
- **Alert status**: `open`, `verifying`, `verified`, `fixing`, `pr_open`, `resolved`, `dismissed`. Stored on the Alert; `alert_events` records how it got there.
- **Event count**: sum of each Scan's error count. Scan windows equal the interval, so they do not overlap.
- **Scan reads**: for Datadog, per env, one `pup logs aggregate` by `service` over `@http.status_code:>=400` (or the picked codes), then one `pup logs search` per Service for its newest 1000 logs in the window. A Scan that names its Services skips the aggregate. Groups, counts and the 10-minute peak come from those logs. The other sources read as their own specs set out.
- **Log with no request**: its Alert hangs on the Service's blank Route (empty method and path), which the API shows as `route: null` and the Services list leaves out.
- **Message of a Datadog log**: its `message`, else `error.message`, `error.kind` or `logger.name`.
- **Healthy sighting**: a Scan that covers a Service writes `cleared_at` on each of its Alerts it did not see. Regression needs a `cleared_at` newer than the Alert's last sighting and `resolved_at`.
- **Finding the code**: names match without case or punctuation. Git hosts are asked with the operator's own tools: `gh repo view` for GitHub, one list of the workspace's repositories through `bkt` for Bitbucket (kept 5 minutes), else `git ls-remote` over SSH with no prompt for Bitbucket and GitLab. Datadog's tag or attribute `git.repository_url` comes first, at the Scan. A Service whose code was not found is looked for again after a week; the look is kept in `services.code_looked_at`.
- **Code source**: the local Repo wins over the Git URL. The URL is `github.com/owner/name` or any URL git clones; a bare host path is cloned over HTTPS with the operator's own git credentials and no prompt.
- **Alert sources**: `scan` is the only source written here; the others are kept for a later ingestion spec.
- **Report storage**: the database holds the Report body; `markdown_path` records where the Report file was written, in the reports folder of the Alert's source Connector, as `<first 8 characters of the Alert id>-v<version>.md`.
- **Review undo**: only a dismissal can be undone by the operator. A closed-unmerged PR undoes a confirmed Review.
- **Fix Session**: the Fix's `repo` Session carries `alert_id`, so the Workspace shows it next to the Alert.
- **Route identity**: ids in a path fold into `:id` (`/orders/1042` and `/orders/1043` are one Route) before a Route is stored or fingerprinted.
- **Datadog reads**: indexed storage only (Flex is not on every account).
- **Healthy Route**: a known Route absent from a Scan's logs gets an `ok` result and zero errors, for its trend.
- **Fingerprint signature**: the most common masked message among a Route's Samples; the newest wins a tie.
- **Severity**: `high` when one 10-minute bucket reaches `rapid_errors_per_10m`; `medium` when errors per hour over the window reach `failing_errors_per_hour` and the status code is 500 or more or a Sample has status `emergency`, `alert`, `critical` or `error` (the other sources also take `fatal`); else `low`.
- **Scan of some codes**: it clears only Alerts with those codes, and writes no healthy Route results: a Route quiet for the picked codes may still fail with others.
- **Schedule slots**: each log source has its own grid, the Connector's daily time and every 6 hours after it. Each distinct interval runs once per slot of its own length, as one Scan of every Service of that source on that interval. A slot that passed while the source is not connected is skipped.
- **Scan on demand**: `POST /scans` needs the Connector of the source asked for connected, and answers `connector_not_connected` otherwise; with no source asked for, it reads every connected one and needs at least one. When several sources are read, one that cannot start its read is stored as a `failed` Scan and the others go on. The answer holds the first Scan.
- **Alert Session**: the first Verification makes one Session linked by `alert_id`: a `repo` Session on the Repo's default branch, or an anonymous Session with the clone. Every later Verification and Fix stage runs in it. `Alert` carries its id as `session_id`. A failed clone deletes that Session, so the next try clones again.
- **Verification steps**: each tool step and text block of the run is stored, redacted, and sent as `verification.stepped`; so are the Recheck and prod version results (`prod-parity-check`).
- **Report file**: written to the source Connector's `reports_folder`, relative to the data folder. A failed write leaves `markdown_path` null and the Report ready.
- **Fix runs**: each agent turn of a stage runs in the Alert Session and ends with a JSON block (`ticket`: key and URL; a Playbook step: its outcome and summary; `pr`: the description; the Jira move: `ok`). Any other answer fails the stage. The `branch` stage is the console's own checkout, with stash, from `07-workspace`; the push and the pull request opening are the console's too.
- **`go` confirm**: the message starts no run. It answers 202 as an ordinary send would.
- **Merged PR**: a merged PR resolves the Alert with `resolved_at` set. A merged PR whose Fix is not `pr_open` is not looked at.
- **Playbook copy**: a Report and a Fix keep the Playbook as copied when they start: its name, rules, Skills and Branch field, and for a Fix the Jira ticket switch. Editing the Playbook later changes no running or finished job.
- **Scratch copy**: a Verification works in a git worktree of the code under `scratch/` in the data folder, so the operator's checkout keeps its branch and uncommitted work. It stays for a failed Report, which Retry needs, and goes once a Report is ready or a newer Verification starts.

## Not required

- **Exact counts under overlap**: two Scans of one Service at once can both add their counts.
- **Log source retention**: Samples are kept and not refreshed.
- **Jira after abandon**: the issue is left as it is.
- **Counts past 1000 Datadog logs**: a Datadog Service with more than 1000 failing requests in the window is grouped from its newest 1000, so counts and peaks are a floor. The other sources count in full, and a Scan's notes say when a read cap cut the Samples.
- **Jira after a Fix without Jira**: connecting Jira later makes no ticket for a Fix already past `ticket`.
- **Clones**: an anonymous Session's folder stays after the Session is deleted.

## Safety

- The agent creates a Jira ticket only after the operator confirms a Report, and moves it to "In review" only when it opens the PR.
- The console clones a Service's Git URL only for a Verification the operator starts. The console, not the agent, pushes the Fix branch and opens the PR, and nothing merges it (ADR 0002).
- A Verification works in a scratch copy of the code, which the console removes when the Report is ready. The Playbook's rules tell it to write files and run commands there only, to read databases only, and to mock every write. A PROD query needs the Connection's Access Level and, for a write, an Approval (`02-settings-agents`). Its commands run in the Run sandbox, which closes the Keychain, `~/.ops-console` and the git control files (ADR 0006).
- The agent cannot change an Alert's status directly; only the Verification and Fix flows do.

## Database

```sql
CREATE TABLE services (
  id              TEXT PRIMARY KEY NOT NULL,
  connector       TEXT NOT NULL DEFAULT 'datadog',  -- LogSource; the code validates it
  name            TEXT NOT NULL,                 -- service name in the log source
  env             TEXT NOT NULL,                 -- env in the log source
  repo_id         TEXT REFERENCES repos (id) ON DELETE SET NULL,
  repo_url        TEXT,                          -- Git URL of the code; from git.repository_url or the operator
  check_interval  TEXT,                          -- CheckInterval; null: Connector default
  code_looked_at  TEXT,                          -- when the code finder last found nothing; null before it looked
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (connector, name, env)
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
  connector      TEXT NOT NULL DEFAULT 'datadog',  -- LogSource read
  triggered_by   TEXT NOT NULL,                  -- ScanTrigger
  service_id     TEXT REFERENCES services (id) ON DELETE CASCADE,  -- null: every Service
  window_size    TEXT NOT NULL,                  -- ScanWindow
  envs           TEXT NOT NULL DEFAULT '[]',     -- JSON array of the envs read
  status_codes   TEXT NOT NULL DEFAULT '[]',     -- JSON array of the HTTP status codes read; empty: every code from 400 up
  services       TEXT,                           -- JSON array of Service names read; null: every Service
  status         TEXT NOT NULL DEFAULT 'running',  -- ScanStatus
  error_code     TEXT,                           -- 'interrupted' when the daemon stopped mid-Scan
  error_message  TEXT,                           -- why a Scan failed; on an `ok` Scan its notes, one to a line
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
  connector         TEXT NOT NULL DEFAULT 'datadog',  -- LogSource the Alert was read from
  fingerprint       TEXT NOT NULL UNIQUE,
  http_status       INTEGER,                     -- HTTP status code of its logs; null: stored before Scans read codes
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
  source_query      TEXT NOT NULL,               -- Datadog: the query string; the others: a JSON filter
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX alerts_status_idx ON alerts (status, last_seen_at DESC);
CREATE INDEX alerts_route_idx ON alerts (route_id);
CREATE INDEX alerts_summary_idx ON alerts (status, http_status);

CREATE TABLE alert_events (
  id        TEXT PRIMARY KEY NOT NULL,
  alert_id  TEXT NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,                       -- AlertEventKind
  actor     TEXT NOT NULL,                       -- AlertActor
  data      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX alert_events_alert_idx ON alert_events (alert_id, at);
CREATE INDEX alert_events_at_idx ON alert_events (at);

CREATE TABLE reports (
  id              TEXT PRIMARY KEY NOT NULL,
  alert_id        TEXT NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',  -- RunStatus
  kind            TEXT,                          -- ReportKind; the agent's recommendation
  slug            TEXT,                          -- short name; ends the fix branch
  sdk_session_id  TEXT,                          -- not written; the transcript is the Alert Session's
  steps           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(steps)),  -- [{ kind, text }]
  replay          TEXT CHECK (json_valid(replay)),  -- { request, response }, redacted
  root_cause      TEXT,
  proposed_fix    TEXT,
  diff            TEXT CHECK (json_valid(diff)),  -- [{ sign, text }] when small enough to show
  markdown        TEXT,
  markdown_path   TEXT,                          -- set once the Report file is written
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at      TEXT,                          -- when the latest attempt began; null until a retry: created_at
  finished_at     TEXT,
  playbook_id       TEXT REFERENCES playbooks (id) ON DELETE SET NULL,  -- the Playbook copied at start
  playbook_name     TEXT,
  playbook_rules    TEXT,
  playbook_skills   TEXT,                        -- JSON array of the Skills offered
  playbook_branches TEXT,                        -- the Playbook's Branch field
  scratch_path      TEXT,                        -- the scratch copy's folder; null once removed
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
  ticket_skipped TEXT,                           -- why no ticket was made while Jira was connected
  branch         TEXT,                           -- '<jira_key>-<slug>', or 'fix/<slug>' without Jira
  pr_number      INTEGER,                        -- in the Alert's Service's Repo
  pr_url         TEXT,
  error_message  TEXT,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at    TEXT,
  playbook_id       TEXT REFERENCES playbooks (id) ON DELETE SET NULL,  -- the Playbook copied at confirmation
  playbook_name     TEXT,
  playbook_rules    TEXT,
  playbook_skills   TEXT,                        -- JSON array of the Skills offered
  playbook_branches TEXT,                        -- the Playbook's Branch field
  playbook_jira_ticket INTEGER NOT NULL DEFAULT 0 CHECK (playbook_jira_ticket IN (0, 1))  -- the Playbook's Jira ticket switch
) STRICT;
```

The steps of a Report's or a Fix's Playbook copy are rows of `playbook_steps` (`agent-playbooks`).

| Enum | Values | Columns |
| ---- | ------ | ------- |
| `CheckInterval` | `24h`, `12h`, `6h` | `services.check_interval` |
| `ScanWindow` | `15m`, `1h`, `4h`, `6h`, `12h`, `24h`, `7d` | `scans.window_size` |
| `ScanTrigger` | `schedule`, `operator` | `scans.triggered_by` |
| `LogSource` | `datadog`, `otel_logs`, `cloudwatch_logs`, `loki_logs`, `new_relic_logs` | `services.connector`, `scans.connector`, `alerts.connector` |
| `ScanStatus` | `running`, `ok`, `failed`, `rate_limited`, `cancelled` | `scans.status` |
| `RouteState` | `ok`, `failing`, `rapid` | `scan_route_results.state` |
| `AlertSource` | `scan`, `datadog`, `sentry`, `slack` | `alerts.source` |
| `Severity` | `high`, `medium`, `low` | `alerts.severity` |
| `AlertStatus` | `open`, `verifying`, `verified`, `fixing`, `pr_open`, `resolved`, `dismissed` | `alerts.status` |
| `AlertEventKind` | `detected`, `regressed`, `verification_started`, `verified`, `verification_failed`, `confirmed`, `dismissed`, `undone`, `ticket_created`, `fix_advanced`, `pr_opened`, `resolved`, `auto_resolved`, `abandoned` | `alert_events.kind` |
| `AlertActor` | `scan`, `agent`, `operator` | `alert_events.actor` |
| `RunStatus` | `running`, `ready`, `failed` | `reports.status` |
| `ReportKind` | `bug`, `improvement` | `reports.kind`, `reviews.kind` |
| `ReviewDecision` | `confirmed`, `dismissed` | `reviews.decision` |
| `FixStage` | `ticket`, `branch`, `steps`, `pr` | `fixes.stage` |
| `FixStatus` | `running`, `done`, `failed`, `abandoned` | `fixes.status` |

Migration of existing rows: existing Sessions and Action Log rows get a null `alert_id`. Severities move `sev2` to `high`, `sev3` to `medium` and `warn` to `low`; existing Scans get `envs` `[]`, a null `services` and `status_codes` `[]`; existing Alerts get a null `http_status` (Behavior 33). Existing Services, Scans and Alerts get the connector `datadog`, and an Alert's `datadog_query` becomes `source_query`.

## API

### Common

Errors added here:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `service_unlinked` | The Alert's Service has neither a Repo nor a Git URL |

`Sample`, one entry of an Alert's `samples` (already redacted):

```json
{
  "id": "string",             // the log source's event id
  "timestamp": "string",      // ISO 8601
  "status": "string",         // the log level: error, warn, info
  "message": "string",
  "attributes": {},           // the source's attributes, body values redacted
  "tags": ["string"]
}
```

`Alert`:

```json
{
  "id": "uuid",
  "route": { "id": "uuid", "method": "string", "path": "string" } | null,  // null: a log with no request
  "service": { "id": "uuid", "name": "string", "env": "string", "repo_id": "uuid | null", "repo_url": "string | null" },
  "connector": "LogSource",           // the log source it was read from
  "fingerprint": "string",
  "http_status": "number | null",     // HTTP status code; null: stored before Scans read codes
  "source": "AlertSource",
  "severity": "Severity",
  "status": "AlertStatus",
  "title": "string",
  "log_line": "string",               // cut to 300 characters in a list
  "event_count": 0,
  "first_seen_at": "string",
  "last_seen_at": "string",
  "resolved_at": "string | null",
  "regression_count": 0,
  "waiting_since": "string | null",   // set while status is verified
  "source_query": "string",           // detail only; Datadog: the query string; the others: a JSON filter
  "session_id": "uuid | null",        // the Alert Session, once there is one
  "last_scanned_at": "string | null", // the end of the newest ok Scan that covered its Service and status code
  "scan_overdue": false,              // no Scan has covered it, or none for two Check intervals
  "awaiting_prod_check": false,       // resolved, and no Scan has read its Service without seeing it since
  "samples": ["Sample"],              // detail only
  "latest_report": "Report | null",   // detail only
  "review": "Review | null",          // detail only
  "fix": "Fix | null"                 // detail only
}
```

`Report`: `id`, `alert_id`, `version`, `status`, `kind`, `slug`, `steps`, `replay`, `root_cause`, `proposed_fix`, `diff`, `markdown`, `markdown_path`, `error_message`, `created_at`, `started_at` (when the latest attempt began), `finished_at` and `playbook` (the Playbook copy and its steps, `agent-playbooks`; null on a Report from before Playbooks), with `steps`, `replay` and `diff` as JSON. Step kinds: `step`, `command`, `output`, `error`, `warning`, `result`.
`Review`: `id`, `report_id`, `decision`, `kind`, `decided_at`, `undone_at`.
`Fix`: `id`, `review_id`, `session_id`, `stage`, `status`, `jira_key`, `jira_url`, `ticket_skipped`, `branch`, `pr_number`, `pr_url`, `error_message`, `started_at`, `finished_at` and `playbook`.

### Services, Routes and Scans

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /services` | query `env?` | Services with `connector`, `routes`, per-Route `state`, `trend` (error counts of the last 7 Scans, oldest first), `open_alert_count`, `last_scan_at` |
| `PATCH /services/:id` | `{ repo_id?, repo_url?, check_interval? }` | Service. `repo_url` must look like a Git URL |
| `POST /services/:id/code` | | 200 `{ service, found: "repo \| url \| null", tried: string[] }`, after looking (Behavior 30) |
| `PATCH /routes/:id` | `{ ignored?, note? }` | Route |
| `GET /scans` | query `service_id?` | the 100 newest, newest first |
| `GET /scans/:id` | | Scan with `results: [{ route_id, error_count, state }]` and `notes` |
| `POST /scans` | `{ service_id: "uuid \| null", connector?: LogSource, window?: ScanWindow, envs?: string[], services?: string[], status_codes?: number[] }` | 202 the Scan in `running`, with `connector`, `envs`, `services` and `status_codes`; the first one when several sources are read. Null `service_id` and no `services` scans every Service. `connector` defaults to every connected source, `window` to the source's `default_interval`, `envs` to every env, `status_codes` to every code from 400 up; a single Service scans its own source and env. Rate limits and failures land on the Scan row and `scan.finished` |
| `POST /scans/:id/cancel` | | 204; the Scan ends `cancelled`; `invalid_state` when it is not running |
| `GET /monitor/envs?connector=` | | `[{ name, configured }]`, the Connector's envs first, `no env` last |
| `GET /monitor/log-services?connector=&window=&envs=a,b&codes=401,500` | | `[{ name, envs, errors }]`, busiest first; `envs` and `codes` optional |
| `GET /monitor/status-codes?connector=&window=` | | `[{ code, count }]`, busiest first |

### Alerts, Reports, Review, Fix

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /alerts` | query `status?`, `service_id?`, `severity?`, `connector?`, `scope?` (`active`, the default, or `closed`), `limit?`, `cursor?` | `Alert[]` without `samples` and `source_query`, newest `last_seen_at` first; `scope=closed` pages with `meta.next_cursor` (Behavior 40) |
| `GET /alerts/summary` | | `{ open }` |
| `GET /alerts/:id` | | `Alert` with detail fields |
| `GET /alerts/:id/events` | | `alert_events`, oldest first |
| `GET /alerts/:id/reports` | | every Report version |
| `GET /reports/:id` | | `Report` |
| `POST /alerts/:id/verifications` | | 202 `Report` in `running`; `invalid_state`, `service_unlinked` |
| `POST /reports/:id/retry` | `{ skip?: boolean }` | 202 `Report` in `running` (Behavior 13a); `invalid_state` |
| `POST /alerts/:id/review` | `{ decision: "confirmed \| dismissed", kind: "ReportKind \| null" }` | `Review`, plus `Fix` on confirm. `kind` required for confirm, null for dismiss. `invalid_state` unless `verified` with a ready Report |
| `DELETE /alerts/:id/review` | | 204; undoes a dismissal; `invalid_state` otherwise |
| `GET /fixes/:id` | | `Fix` |
| `POST /fixes/:id/retry` | `{ skip?: boolean }` | 202 `Fix`; `invalid_state` unless `failed`, and for `skip` unless it failed in `steps` |
| `POST /fixes/:id/cancel` | | `Fix`, `abandoned` (Behavior 38); `invalid_state` unless `running` or `failed` without a pull request, or while it is being cancelled; `upstream_failed` when git refuses |

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
| `alert.reviewed` | `{ alert_id, decision: "confirmed \| dismissed \| undone" }` | Confirm, dismiss, undo, and `undone` when a PR closes unmerged |
| `fix.advanced` | `{ fix_id, alert_id, stage, status, jira_key, pr_number }` | A Fix changes stage or status |
| `playbook_step.updated` | `{ report_id \| null, fix_id \| null, position, status, summary }` | A step of a Verification's or a Fix's Playbook copy changes (`agent-playbooks`) |
| `alert.resolved` | `{ alert_id }` | A merged PR resolves an Alert |

## UI

- Monitor, whole page: with no log source connected and no Service stored, it shows only "Connect Datadog, OpenTelemetry logs, CloudWatch logs, Loki logs or New Relic logs in Integrations." Otherwise it is a header, a row of source tabs, a toolbar and one table of Alerts, with the open Alert in a drawer on the right ([monitor-source-tabs](monitor-source-tabs.md)). While the Connectors and Services load it reads "Reading the Monitor…".
- Monitor, header: the title, one status sentence, the range buttons `15m`, `1h`, `4h`, `24h` and `7d` (`24h` at first), an `HTTP` field and the Scan button. The field shows "400+" or the picked codes. It opens the codes of the sources in view (the same code from several sources adds up) with their names and counts, under 4xx, 5xx and other, each class with its own checkbox and an arrow that folds it, and "Every code from 400 up" (the default) on top. Ticking every listed code is the same as every code; the last ticked code cannot be unticked. Range and codes are remembered in the browser. There is no env pick: every env is read. While the codes load the field reads "Reading status codes…"; with no source connected, "No log source is connected."; on an error, "Could not read status codes:" and the reason.
- Monitor, status sentence: it covers the sources in view and stays on one line. It reads "All 5 sources scanned · last Scan 6h ago", or with one source "Last Scan 6h ago", with "Scanning Loki" and "No Scan yet" where they apply. In red it adds "Scan failed for Datadog", "Scan stopped for Loki", "Loki is down" and "Scan overdue for apis and zeta" (three or more Services read "3 Services"); in amber, "Loki and New Relic left notes". A sentence with a red or amber part opens a box on click, closed by Esc or a click outside. The box names each source that needs a look with why: for a Scan, "The last Scan hit a Datadog rate limit.", "could not read" it or "was stopped", then "Last good one 2h ago." or "No good Scan yet."; for a source that is down, the check's reason and that Scans skip it until a check passes; and its notes. An Overdue entry names the Services. A refused Scan request shows its error beside the sentence.
- Monitor, source tabs: "All sources", then one tab per log source that is connected, down or holds Alerts. A tab shows the source's logo and name, its open Alerts as counts per tier (red High, amber Medium, grey Low) or "No open Alerts", and one line of state: "Last Scan 3m ago", "Scanning…", "Last Scan failed", "Last Scan stopped", "No Scan yet", or the reason the source is down. A source that is down or whose Scan failed or stopped carries a red dot and red text; a Scan with notes carries an amber mark that shows them on hover. "All sources" shows the open counts of every source and "N of M ok". The pick is remembered, and it limits the table, the Services menu, the codes and the Scan button to that source.
- Monitor, toolbar: the severity switch ("Needs attention", All, High, Medium, Low, each with its count), a search box that keeps the Alerts where every word typed sits in the Route, log line, title, status code, Service or status, in any case (the counts follow it), the Services menu and the Closed switch. At the right it reads "12 logs · 24h · HTTP 400+".
- Monitor, Services menu: a button reading the picked Service or "N Services", with "N ticked" when any are ticked. It opens a list with a filter box once there are more than 8 rows, "All Services" with the row count, and "Tick Services to Scan" (or "N ticked") with Tick all and Clear. The rows sit in a section per log source, each with an arrow that folds it and a checkbox that ticks its Services; a section holds the source's Services from Behavior 31, A→Z, with the Services that have open Alerts but no failing requests in the range among them at 0. A row has the name, the count, a bar of the count against the busiest, and its open Alerts with a picked code as coloured counts per tier. The row checkbox shows on hover, and on every row once any is ticked. Ticking does not change the table; picking a row does, and "All Services" clears the pick. Ticks and the pick are by Service name. States: "Reading Services from Datadog…", "Could not read Services:" and the reason, and "No failing requests in 24h for these status codes."
- Monitor, Scan button: "Scan checkout-api · 24h" for one ticked or picked Service, "Scan 3 ticked · 24h", or "Scan 12 Services · 24h" for every listed one. It is disabled with no source connected, a Scan running or nothing to scan, with the reason on hover. While a Scan runs it shows a spinner and "Scanning…", with Stop beside it (Behavior 34).
- Monitor, table: one row per Alert, with severity, the Route (method and path, or the title when there is no Route), the status chip when it is not `open`, the first line of the log, a warning when no Scan has read its Service for two Check intervals ("last scanned 9h ago · a Scan was missed", or "never scanned") and "Merged, not yet seen healthy in prod" for a merged Fix no Scan has seen healthy. Then the Service, the status code badge (amber for 4xx, red for 5xx and above, its name on hover), the source logo, ×count, the trend of the Route's last Scans and the last seen time. The Service and trend columns drop out below 1180 px. On "Needs attention", "Show 8 Low alerts · failing below the Medium threshold" opens the Low tab. The rows come 100 at a time, with "Show 100 more · 100 of 1240"; a new Service, tab, source, Closed, code or search starts at 100 again. Empty: "No logs from checkout-api yet. Scan it for the last 24h.", "No logs yet. Pick a Service or Scan them all.", "No logs match “<words>”." or "None here." when a tab holds none. States: "Reading Alerts…" and "Could not read Alerts:" with the reason.
- Monitor, drawer: it opens at 580 px, over the right of the table; dragging its left edge resizes it until it closes, and a double click on the edge resets it. Esc, the close button or a click on the dimmed table closes it. Its header has the severity badge, the source, the status, "regression ×N" when it has regressed, "waiting since" while `verified`, the freshness note, the title, the Service, env and Route (or "no HTTP route"), and the tabs Overview, Samples, Query and History. Overview holds the four steps (Link code, Verify, Review, Fix and PR) with the current one marked, the Code card, the stats (events, status, first seen, last seen), the log line, the Report panel, the dismissal note and the Fix progress. Samples holds the Samples with a search box; a click on a message opens the Sample as JSON in a dialog. Query holds the source query as the source reads it: the Datadog query, or a line such as `service api, env prod, 500 POST /orders`. History holds the events, oldest first with the actor.
- Remembered view (`persist-selections-and-runs`): the address holds `?service=<name>&alert=<id>`. The browser keeps the source tab, the severity switch, Closed, the ticks, the Services filter, how many rows are drawn, the search and each Alert's picked Report version, with the range and codes.
- A button that starts the agent (Verify, Fix, Retry) greys out with a spinner from the click until the run's status is back, and carries " · <Playbook name>" when the Trigger's Playbook is not the built-in. Verify sits in the drawer's footer and reads "Verify with agent", "Verify again" on a `verified` Alert, and "Starting the agent…" after the click; it stays greyed, reading "Agent verifying…", while the Alert is `verifying`. After a failed Report the footer offers "Retry from step N" and "Skip step N" for the newest version, and says so when an older version is shown.
- Code card: the local Repo picker. With no local Repo the card looks for one by the Service's Routes once per page (Behavior 30), then says "No local Repo found" with the Git URL if there is one, or that no imported Repo serves the Routes. When nothing is linked it lists where it looked, with Look again. Verify is disabled until the Service has a Repo or a Git URL.
- Report panel: the Playbook link, then a path of its steps and the closing turn while `running`, with Stop beside the status and how long it has taken; when ready, the Recheck and prod version notes, the Report Markdown drawn, then the Playbook, diff, replay and agent steps folded, and where the file was saved. A failed one says "The Verification did not finish" with its reason, and its steps. A version picker (`v2 · ready`) shows when there are several. "Open the Session →" goes to the Alert's Session in Workspace.
- Review, while `verified` with a Report kind: Fix with agent (the Report's kind), Fix as the other kind, and Dismiss. A line says where the Fix runs and whether a Jira ticket comes first; with no ticket it says the branch is `fix/<name>`, and why. A dismissed Alert says it is checked again at the next Scan, with Undo.
- Fix progress: a path down the card with a node per stage joined by a line, under a bar that counts the stages
  passed. The stages are Ticket, Branch, each of the Playbook's steps by title, and Pull request. A done node is ticked, the running one turns and is tagged "In progress", a failed one is crossed and
  tagged "Failed", a skipped one is dashed. Each stage shows what it made under its title: the Jira key, or on a skipped
  ticket "No ticket:" and why, or "No Jira connected."; the branch; each Playbook step's summary; the PR link, with "Committing, pushing and opening the PR…" while it runs. The failed stage holds the
  error and "Retry from step N" or "Retry from" the stage, with Skip step N beside it for a failed step. "Open the Session →" goes to the Session in Workspace; while the Fix runs, Stop sits beside it.
  Cancel Fix sits there too while the Fix runs or failed before its pull request; its dialog says what is undone,
  with "Keep it" and "Cancel the Fix".

## Rejected

- **One Alert per Scan**: the same failure would come back as a new card every day and restart the "waiting since" clock. Sentry and PagerDuty group repeats under one key.
- **Only the source query and trace ids**: nothing to read once the log source drops the logs, and the Report's replay has no source.
- **Status derived from `alert_events`**: every list query would aggregate events.
- **Jira required for a Fix**: an operator without Jira could not fix anything. With Jira the branch still carries the key, so Report, ticket and PR stay linked.
- **Route aggregates only**: logs from workers and jobs carry no method or path, so a Scan never saw them.
- **Agent searches the Git hosts for the code**: a model guess can pick the wrong repository. The finder asks only for the exact name, and the operator's choice overrides it.
- **Scans as agent runs**: a Scan is a fixed read; a model turn per Scan costs tokens and gives different answers for the same data (ADR 0005).
- **A Services column and a logs column beside the Alert**: four columns do not fit a window about 1000 px wide, and the Scan controls sat away from the logs they read. One table under source tabs, with the Alert in a drawer, replaces them ([monitor-source-tabs](monitor-source-tabs.md)).

## Glossary

- **Fingerprint**: The identity of an Alert: Service, Route (none for a log with no request), HTTP status code and the error signature with ids, numbers, timestamps and addresses masked. For every log source but Datadog the source is part of it too. Two failures with the same Fingerprint belong to one Alert.
- **Regression**: A resolved or dismissed Alert that fails again after a healthy Scan. It reopens the same Alert.
- **Sample**: One log event kept on an Alert, with secret values and request body values redacted.
- **Ticket**: The Jira issue the agent creates when the operator confirms a Report, while Jira is connected and the Fix Playbook asks for one. Its key starts the fix branch name.
- **Fix**: The work that follows a confirmed Review: ticket (when its Playbook asks and Jira is connected), branch, the steps of its Playbook, the agent's PR description, then the console's push and PR opening, in the Alert's Session.
- **Log source**: Where a Scan reads failing requests from: Datadog, a Log folder, CloudWatch logs, Loki or New Relic. Each is a Connector, and a Service, an Alert and a Scan belong to one source.
- **Freshness**: How long since the last finished Scan that covered an Alert's Service and status code. It warns past two Check intervals.
- **Recheck**: One read of the Alert's log source for its query over the last hour, made when a Verification or a Fix starts, with no model turn.
- **Severity**: An Alert's tier. High: one 10-minute bucket reaches the rapid threshold. Medium: errors per hour reach the failing threshold, and the logs are at error level or the status code is 500 or more. Low: anything else.

## Seams

- **Backend + SQLite, over HTTP** (Supertest, temporary data directory, fakes for the log readers, the agent runtime, the Atlassian MCP server and the Git host adapter, a fake clock for the scheduler; a local git repository as the clone source): 1 to 9 with 1a, 5a, 7a, 8a and 10, 11, 12, 13a, 14 to 20, 22, 24, 26 to 33, 39, 40. Start-up cases close the app and open it again on the same data directory.
- **Backend + SQLite, over WebSocket**: 13, 21, 23, 25. Asserts the events and the `alert_events` rows written with each change.
- **Browser (Playwright e2e)** (`frontend/e2e/monitor-lists.spec.ts`): 34 to 37, and the UI states above.
- **Unit**: 10, and the log grouping behind 2 and 4. Fingerprint masking, groups by Route and message, the 10-minute peak, the Git URL tag, the searchable Route path of 30.

## Out of scope

- Log source and Jira Connector config, sign-in and `connector_not_connected`: `04-settings-connectors`. How each source reads its logs: [otel-log-source](otel-log-source.md), [cloudwatch-log-source](cloudwatch-log-source.md), [loki-log-source](loki-log-source.md), [new-relic-log-source](new-relic-log-source.md) and [one-click-log-sources](one-click-log-sources.md).
- Agent runtime, redaction and the Action Log: `02-settings-agents`.
- The Git host adapter: `07-workspace`.
- Playbooks, their steps and Skills, and Skip step on a running step: [agent-playbooks](agent-playbooks.md) and [playbooks-redesign](playbooks-redesign.md).
- The Recheck, the deployed version step, Freshness and the Prod parity section: [prod-parity-check](prod-parity-check.md).
- Alerts from Datadog monitors, Sentry and Slack: a later ingestion spec.
