# Monitor and Workspace list redesign

**Status:** shipped
**Design:** Monitor (Services and logs columns) and Workspace (Sessions, pull requests) in `design/ops-console.html`.

## Problem

The Services column is crowded: a wall of Service names under the Scan button, an "Untick all 27" link that shows
after Tick all, and a tall Status box. The logs column leads each row with a tier pill, so the Route is hard to find.
The pull request and Session lists do not say when something was opened or started.

## Behavior

1. The Services header holds the title with the Service count, one muted line, the range buttons, then an `HTTP`
   status picker and the filter on one row. The picker reads `HTTP 400+` for every code, or the picked codes.
2. A Service row is two lines: name and count, then the bar with its tier counts beside it. The tick box shows on
   hover, and on every row once any Service is ticked.
3. Above the list, "Tick Services to Scan" with "Tick all". With ticks it reads "N ticked" with "Tick all" and
   "Clear". Nothing sits under the Scan button to untick.
4. The Scan button reads "Scan checkout-api · 24h" for one, "Scan 3 ticked · 24h", or "Scan 12 Services · 24h".
5. Under the button, one line: "Last Scan 5m ago" with a toggle that opens the Services, range and codes that Scan
   read. The names show only when it is open. A failed Scan keeps its warning text.
6. The logs header holds the Service name, "Failing logs" and the range with codes. Tabs All, High, Medium and Low
   carry a tier dot and the count. The search box and a Closed switch share one row.
7. A log row is titled by its Route (method, then path), or the title when it has none. A tier-coloured bar replaces
   the tier pill. It shows last seen on the right, then the Service when all are shown, the status code, `×count`
   and the status when it is not `open`, then the log line in two muted lines.
8. On the All tab, rows group under High, Medium and Low heads with counts. A tier tab shows no heads.
9. A pull request row shows "Opened Nov 5 · 2:14 PM" with the relative time under it. The year shows for another
   year.
10. A Session row shows "Started Nov 5 · 2:14 PM · active 3h ago".

## Not required

- **Session day groups**: Sessions keep their last-active order with no Today and Yesterday heads.

## Safety

No change.

## UI

Follows the redesigned Services and logs columns in `design/ops-console.html`. Loading, empty and error states are
unchanged.

## Seams

- **Browser** (`frontend/e2e/monitor-lists.spec.ts`): 1 to 10.

## Out of scope

- Merged date on closed pull requests.
