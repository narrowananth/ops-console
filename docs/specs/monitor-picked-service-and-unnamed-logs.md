# Monitor: a picked Service stays in its source, and logs with no Service or no status code show

**Status:** shipped
**Design:** the Monitor page (`design/ops-console.html`): the Services menu and the source tabs.

## Problem

Seen in daily use with Datadog and New Relic connected:

- The operator picks a Datadog Service in the Services menu, ticks and unticks boxes, and the Monitor keeps showing that
  one Service and the button keeps reading "Scan shopify-auth-proxy". Unticking changes nothing, because the pick is a
  separate thing from the ticks, and only "All Services" clears it, which is easy to miss.
- The pick follows the operator to the New Relic tab. New Relic has no Service of that name, so it lists "No logs from
  shopify-auth-proxy yet", and a Scan reads only that name, so an error log New Relic holds is never read.
- A log that holds an error level but no HTTP status code makes an Alert with no status code. The Monitor hides such an
  Alert while it is open, as if it came from before Scans read codes, so the Alert exists and is never listed. The card
  reads "No open Alerts".
- A New Relic log with no `service.name` is not read at all, since a Service is found from that attribute. A log with a
  status code or an error level is wanted whether or not it names a Service.

## Behavior

1. A click on a source tab clears the picked Service, so the list and the Scan button show that source's Services. A click
   on the tab already open keeps the pick.
2. While a Service is picked, the Services button shows a button that clears the pick ("Show every Service"), beside its
   name. Clearing it returns the list and the Scan button to every listed Service, or to the ticked ones.
3. Ticks and the pick stay two things: a Scan reads the ticked Services, else the picked one, else every listed one. The
   Scan button and the Services button each say which, so unticking the last tick reads as the pick again, visibly.
4. An Alert with no HTTP status code shows in the Monitor list, the cards' counts and the Service counts when no status
   codes are picked (the default "HTTP 400+" reads every code). When one or more codes are picked it does not show, as it
   has none of them.
5. New Relic reads a failing event (a status of 400 or more, or an error level) that has no `service.name` as the Service
   `(no service)`, in its own env. A Scan with no Service restriction reads it; a Scan of ticked Services reads it only
   when it is ticked. Its Alerts, counts and status codes read like any Service's. The Service list holds `(no service)`
   only when such an event exists in the range.
6. The note "New Relic logs: no Services found under the attribute service.name" goes. A Scan of an account with no logs
   in the window says "New Relic logs: no logs in this window".
7. What must not regress: the Scans of the other sources, the ticks kept across reloads, Alerts with a status code and the
   code pick, and a pick opened from a link (`?service=`), which stays until the operator changes the source.

## Settled

- **Pick cleared by the source tab**, not by the Services list: the pick belongs to the list in view, and the list changes
  with the tab.
- **No status code is shown by default.** The label "HTTP 400+" covers an error log with no code: a Service that fails
  with no code is as much a failure as one with a 500. Picking codes narrows to Alerts that have them.
- **`(no service)`** is the one name for every event with no service attribute, per env, since nothing tells two apart.
- **The other four sources keep their Service rule** (Datadog's `service` tag, the OpenTelemetry resource, CloudWatch's log
  group, Loki's label): their logs are grouped by something that is always present or is a setting.

## Not required

- **A no-service Service in Datadog, Loki or OpenTelemetry logs.** Each would need its own query; New Relic is the one that
  reported it.
- **Telling a legacy Alert (stored before Scans read codes) from a level-only one.** Both have no status code and both show.

## Safety

No change.

## Seams

- **Source tab and pick** (frontend e2e): 1, 2, 3, 7.
- **Alerts with no status code** (frontend e2e): 4.
- **New Relic no-service events** (backend, over HTTP, NRQL stand-in): 5, 6.

## Out of scope

- A no-service rule for the other four sources, and a legacy-Alert marker.
