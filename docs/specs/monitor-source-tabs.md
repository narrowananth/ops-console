# Monitor: source tabs, alerts table, Alert drawer

**Status:** shipped
**Design:** `design/monitor-redesign.html`. It departs from the Monitor in `design/ops-console.html`: no Services column and no logs column; one table under source tabs, and the Alert in a drawer.

## Problem

The Monitor spreads four columns across a window about 1000 px wide: the sidebar, the Services, the logs and the Alert. The Scan controls sit in the Services column, away from the logs they read. Three rows of filters sit above the logs, and thousands of Low Alerts bury the few High ones. With five log sources connected there is no place that shows which source is healthy, scanning or down.

## Behavior

1. The Monitor is a header, a row of source tabs, a toolbar and one table of Alerts. The Alert opens in a drawer on the right and covers part of the table; Esc, the close button or a click on the dimmed area closes it. The picked Alert stays in the address, so Back and a reload keep the drawer open.
2. The header is one row: the title, one sentence of status, the range buttons, the `HTTP` status picker and the Scan button. The row wraps only when the window is too narrow for all of it. The status picker groups codes by class (4xx, 5xx, other), and each class has an arrow that folds and opens it. The Scan button reads "Scan checkout-api · 24h", "Scan 3 ticked · 24h" or "Scan 12 Services · 24h". While a Scan runs it reads "Scanning…" and a Stop button shows.
   The status sentence covers the sources in view and never runs to a second line. When all went well it reads "All 5 sources scanned · last Scan 6h ago"; with one source, "Last Scan 6h ago". Something the operator must act on joins it in red: "Scan failed for Datadog", "Scan stopped for Loki", "Loki is down", "Scan overdue for apis and zeta". Scan notes join it in amber: "Loki and New Relic left notes". A sentence with a red or amber part is a button with an arrow; one click opens a box under it with each source's reason and notes, and Esc or a click outside closes it. A sentence with nothing to open is plain text. Per-source times stay on the tabs.
3. Source tabs sit under the header: "All sources", then one tab per log source that is connected, down or has Alerts. A tab shows the source's logo and name, its open High, Medium and Low counts, and one line of state: "Last Scan 3m ago", "Scanning…", "Last Scan failed", "Last Scan stopped", "No Scan yet", or why the source is down. The tab of a source that is down or whose Scan failed carries a red dot and red text. A tab whose Scan left notes carries an amber mark that shows the notes on hover. The "All sources" tab shows the open counts of every source and "N of M ok".
4. Picking a tab lists only that source's Alerts and makes the Scan button read only that source. The pick survives a reload.
5. The toolbar holds a severity switch, the search box, a Services menu and the Closed switch. The switch reads "Needs attention" (High and Medium), All, High, Medium and Low, each with its count. "Needs attention" is the default.
6. On "Needs attention" a row under the Alerts reads "Show N Low alerts" while Low Alerts are hidden; it opens the Low tab.
7. The Services menu opens a list of the Services in view with their failing-request counts and tier counts, grouped under a section per log source. Each section has an arrow that folds and opens it, and a tick box that ticks its Services. Clicking a name shows only that Service's Alerts; "All Services" clears it. A tick box on each row adds it to the next Scan, with "Tick all" and "Clear" above the list and "N ticked" when any are ticked.
8. A table row shows severity, the Route (method and path, or the title when there is no Route), the first line of the log, the Service, the status code, the source logo, `×count`, the trend of the Route's last Scans and the last seen time. A status other than `open` shows as a chip. Clicking a row opens its drawer. The table reads a hundred rows at a time and says how many are left.
9. The drawer holds the severity, source and status, the Route title, the Service and env, and tabs in the Accounts and Usage look: Overview, Samples, Query and History. The drawer opens at the same width every time; dragging its left edge makes it wider or narrower until it closes, and a double click on the edge resets it. Overview leads with the four steps (Link code, Verify, Review, Fix and PR), the step that is current marked, then the Local Repo picker (no Git URL field), the stats (events, status, first seen, last seen), the log line, the Report and the Fix progress. Samples holds the Sample list with a search box; clicking a Sample's message opens it as JSON in a dialog. Query holds the Alert's stored query in the form the source reads it, with its copy icon and the hover text. History holds the Alert's events.
10. A footer pinned to the drawer holds the Alert's next action: Verify with agent (greyed with the reason until the Service has code), or the Review buttons once verified, or Retry and Skip after a failed Report. Retry and Skip belong to the newest Report version: while an older version is shown, the footer says so and offers neither. A dismissed Alert keeps its Undo in Overview.
11. Opening an Alert whose Service has no local Repo looks for one: the imported Repo whose source holds the Service's Route paths (up to eight, cut before any dynamic segment; tests and docs left out). The Repo that holds the most Routes is linked and shown in the picker; two Repos that hold the same number stay unlinked unless only one carries the Service's name. Nothing found leaves the picker on "No local Repo" for the operator to pick. A Service that has a Git URL but no local Repo is looked for the same way.
12. Below 1180 px wide the Service and trend columns drop out; the tabs scroll sideways.
13. With no log source connected and no Service, the Monitor shows a "Connect … in Integrations" line naming the log sources.

## Settled

- **Needs attention**: High and Medium. It is a view of the severity switch, kept across reloads like the other tiers.
- **Services menu**: the Service pick and the Scan ticks live in one menu; the pick filters the list and the ticks choose what the next Scan reads; both persist across reloads.
- **Trend**: the error counts of a Route's last Scans (`trend` on the Route), not an hourly series. A row with no Route, or a Route with no Scans, shows none.
- **Not drawn from the design**: "Seen in N sources". An Alert has one log source, and the Fingerprint stays per source, so the drawer names that one.

## Not required

- **Ignore this Route in the Monitor**: the Alert offers no way to ignore a Route; Routes already ignored stay ignored.
- **The Services column**: the Services with no failing requests in the range and no open Alert stay out of the menu, as they did out of the column.
- **A split Scan button**: the source tab and the Services menu already say which logs a Scan reads.

## Safety

No change. Verify, Fix and Review keep their guards and their wording.

## UI

Follows `design/monitor-redesign.html`. Loading, empty and error states of the list and the Alert keep their wording.

## Seams

- **Browser** (`frontend/e2e/monitor-lists.spec.ts`): 1 to 10. The header test measures the status line and the table's top.

## Out of scope

- Merging one failure seen in several sources into one Alert.
- A change to the API's shapes. The Repo search is the code finder's own step, in the daemon.
