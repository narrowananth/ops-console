# Prod parity check

**Status:** shipped
**Design:** Monitor in `design/ops-console.html`: the Alert row and the Report panel ("Report v2" card). The
Freshness badge, the merge line and the Prod parity section are new to the design.

## Problem

The operator reads an Alert in the console and trusts what it says. It can be hours old: a Scan runs every 6, 12 or
24 hours, and a missed slot makes it older. The failure may be gone, or the code in prod may not be the code the agent
read. A Verification then reproduces the bug on the newest commit of a branch, with mock data, and the Report reads
as "works on my machine" or "fails on my machine" with nothing to say how far that machine is from prod. After a
merge the Alert shows `resolved` at once, though nothing has shown that prod is healthy.

## Behavior

### Freshness

1. Each Alert shows its Freshness: "last scanned 9h ago", on the Alert row and in the Alert's header above the
   Report panel. It counts
   from the end of the newest Scan with status `ok` whose Services and status codes include the Alert's. A `failed`,
   `rate_limited` or `running` Scan does not count.
2. Past two Check intervals the text becomes a warning badge, "last scanned 9h ago · a Scan was missed". The
   interval is the Service's own, or the one its Scans use when the Service has none.
3. An Alert no Scan has covered since the console recorded Scans shows "never scanned" as a warning.
4. A running Scan does not reset Freshness. Freshness updates when the Scan ends, through the existing
   `scan.finished` event, which already makes the UI read the Alerts again.

### Recheck

5. Pressing Verify or starting a Fix first reads Datadog once for the Alert: its `datadog_query` over the last hour,
   in the Alert's Service and env, through `pup`, with no model turn. The result is one of `still_failing` (at least
   one log) or `not_seen` (none).
6. The Recheck result goes into the agent's brief as one line: "Datadog recheck, last hour: still failing" or "not
   seen". A Recheck that failed puts "could not be read (<reason>)" in its place. The agent's run starts either way: a
   Recheck never blocks Verify or Fix.
7. A Verification writes the result as the first step of its Report, so the Report panel shows it after a reload. A
   Fix has no Report: its result reaches only the brief.
8. A Recheck that fails (Datadog rate limit, `pup` signed out, a timeout) writes "Recheck failed: <reason>", and the
   run goes on. A rate limit does not retry.
9. A Recheck is made for every Verification and every Fix start, including a retry. A Recheck result is never
   cached. A retried Verification resumes its conversation, so its new Recheck reaches the Report as a step and not
   the agent's brief.

### Deployed version

10. A Verification reads the version prod ran from the Alert's Samples: the `version:` tag of the newest Sample that
    has one.
11. After the scratch copy exists, the Verification writes a Report step: "prod ran `<version>`; verified at
    `<short commit>` of `<branch>`".
12. The step is a warning when no Sample has a `version:` tag ("prod version unknown"), or when the version is not a
    prefix of the commit. A version under 7 characters never matches. A version that is not a commit (`v2.1.4`)
    therefore warns: the console cannot confirm it matches.
13. The scratch copy stays at the newest commit of the Playbook's branch, as before. When the version is a different
    commit, the Report says so and the code is not checked out at it.

### Prod parity

14. A Verification's closing turn writes a "Prod parity" section into the Report's Markdown, in four lines: Code
    version, Data, Configuration and environment, Dependencies. Each line says what in this run matched prod, what
    was mocked or read from a dev Connection, and what could not be checked.
15. The Report panel shows the section with the Report text, after reload and in the saved Markdown file.
16. The Fix stage that opens the PR tells the agent to put the same four-line "Prod parity" section in the PR
    description, with what this Fix's tests mocked.
17. A Report or a PR body with no section is still saved and opened: the instruction is a prompt, and the console
    does not check it.

### After a merge

18. A merged PR still moves the Alert to `resolved` at once, as before.
19. A `resolved` Alert shows "Merged, not yet seen healthy in prod" on its row and in its header until a Scan
    that covers the Alert's Service ends without seeing it, after `resolved_at`. Then the text goes.
20. A Regression reopens the Alert: `open`, with no "Merged" text.
21. A resolved Alert whose Service has no later Scan keeps the text however long it takes.

### What must not regress

22. Scans, Alert grouping, Regressions and the Fix flow behave as before. A Verification with a failing Recheck
    still ends in a Report.
23. Two Alerts started together each make their own Recheck. One's failure does not affect the other.
24. A reload mid-Verification shows the Recheck step already written, and the rest as it arrives.
25. PROD: the Recheck reads logs only, as a Scan does. The agent's reach is unchanged.

## Settled

- **Freshness**: the time since the last finished Scan that covered the Alert's Service and status code. A term in
  `GLOSSARY.md`.
- **Prod parity**: the Report's account of how this run differed from prod. A term in `GLOSSARY.md`.
- **Warn only**: no badge, Recheck or missing section stops Verify, Fix or a merge.
- **Threshold**: two Check intervals, so one missed slot warns and one late Scan does not.
- **Recheck window**: the last hour, fixed; it is not the Check interval.
- **Where the Recheck result lives**: a first Report step for a Verification; the brief only for a Fix.
- **Where Prod parity lives**: the Report's `markdown` and the PR body; no column.
- **Where Freshness and the merge label come from**: computed when the Alert is read, from `scans`,
  `alerts.resolved_at` and `alerts.cleared_at`. No stored field.
- **No new Alert status**: `resolved` keeps its meaning; the label is display only.

## Not required

- **Prod's exact code**: the Report says the deployed commit differs; the operator sees a warning, not a checkout at
  that commit.
- **A Recheck gate**: a failing Alert that "is not seen" still verifies.
- **Enforced parity**: the console does not check the section exists or is true.
- **Live Freshness**: the age text refreshes when the Alert is read again, not each second.

## Safety

No change. The Recheck is a fixed `pup` read of logs, the same reach as a Scan, with no model turn. The agent's tools,
Connections and approvals are as before. It still never merges.

## Database

No change. Existing rows need no migration.

## API

### Common

`Alert` gains three computed fields. Both the Alert list and the Alert detail carry them.

```json
{
  "last_scanned_at": "2026-11-04T04:00:00.000Z",
  "scan_overdue": true,
  "awaiting_prod_check": false
}
```

- `last_scanned_at`: the end of the newest finished Scan that covered the Alert's Service and status code; `null`
  when none has.
- `scan_overdue`: `true` when `last_scanned_at` is `null` or older than two Check intervals.
- `awaiting_prod_check`: `true` when `status` is `resolved` and no Scan that covered the Service has ended without
  seeing the Alert after `resolved_at`.

No new endpoint, status or error. The Recheck failing is a Report step, not an API error.

### `POST /api/alerts/:id/verifications`, `POST /api/alerts/:id/review`, `POST /api/reports/:id/retry`, `POST /api/fixes/:id/retry`

Unchanged on the wire. Each makes the Recheck before its run starts (Behavior 5 and 9). `review` starts a Fix when the
decision is a confirm.

### WebSocket `scan.finished`

Unchanged. The UI already reads the Alerts again on it, so Freshness and `awaiting_prod_check` refresh without a
reload.

## UI

Monitor: the Alert row and the Report panel, following "Report v2" in `design/ops-console.html`.

- **Alert row**: beside the Route, "last scanned 9h ago". Past the threshold or never scanned, it is a warning badge.
  Past the threshold its Tip says: "No Scan has read this Service for 2 Check intervals. The failure may be gone." For
  never scanned it says: "No Scan has read this Service since the console began recording Scans."
- **Resolved row and header**: "Merged, not yet seen healthy in prod" beside the status. Tip: "The
  next Scan that reads this Service and does not see the failure clears this."
- **Report panel**: the Recheck step and the "prod ran / verified at" step first, as a short list with a warning pill
  when Behavior 12 applies, then the Report text with its "Prod parity" section.
- **States**: loading as the Alert row today; a Recheck that failed shows its reason in the step; PROD changes
  nothing here.

Departure from the design: all three texts are new.

## Rejected

- **Blocking stale Alerts**: the operator asked for warnings only; a block stops a valid Verification of an old
  Alert.
- **A one-Service Scan before Verify**: reads and rewrites Alerts as a side effect of pressing Verify.
- **A new Alert status for "merged, waiting"**: needs a migration and a state-machine change for a label.
- **Checking out the deployed commit**: a Fix branches from the branch tip, so the two would not match.
- **A `reports.prod_parity` column**: the panel does not need rows it cannot already read from the Markdown.

## Glossary

- **Freshness**: how long since the last finished Scan that covered an Alert's Service and status code; warns past two
  Check intervals.
- **Prod parity**: the section of a Report or pull request description that says how the run differed from prod: code
  version, data, configuration and environment, dependencies.
- **Recheck**: one read of Datadog for an Alert's query over the last hour, made when a Verification or Fix
  starts, with no model turn.

## ADR

None. Each decision is easy to reverse.

## Seams

- **Backend + SQLite** (`backend/test/monitor.test.ts`, with its Datadog stub): Behaviors 1 to 3 (Freshness and
  `scan_overdue`), 4 (Freshness reads `ok` Scans only), 5 to 9 (Recheck, brief, first Report step, failure, every start), 10 to 13
  (version step and its warning), 14 and 16 to 17 (the closing turn and PR instruction carry the section), 18 to 21
  (`awaiting_prod_check`), 22 to 25 (no regression, two Alerts, reload, PROD).
- **Browser** (Playwright with the API routed, `e2e/prod-parity.spec.ts`; the frontend has no component runner): Behaviors 1 to 3 (badge and text), 15 (section shown), 19 to 21
  (merge label), 24 (steps shown in order).

## Out of scope

- Checking out the deployed commit for a Verification. A later spec, with the Fix branch base settled first.
- Reading prod's config and environment automatically. The section states what the agent could not check.
- Pushing a "Merged, not yet seen healthy" Alert to Slack. Notifications are not part of the console yet.
