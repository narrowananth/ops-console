# Monitor and Workspace list redesign

**Status:** superseded. Monitor items by [monitor-source-tabs](monitor-source-tabs.md), Workspace items by [workspace-inbox-and-pr-cockpit](workspace-inbox-and-pr-cockpit.md); items 2 to 4 still hold in the Services menu.
**Design:** none left of its own: `design/monitor-redesign.html` for the Monitor, `design/workspace-variants.html` for the lists.

## Problem

The Services column is crowded: a wall of Service names under the Scan button, an "Untick all 27" link that shows
after Tick all, and a tall Status box. The logs column leads each row with a tier pill, so the Route is hard to find.
The pull request and Session lists do not say when something was opened or started.

## Behavior

1. Superseded by monitor-source-tabs item 2: the header holds the title, one status sentence, the range buttons, the
   `HTTP` status picker and the Scan button. The picker reads `HTTP 400+` for every code, or the picked codes.
2. A Service row in the Services menu is two lines: name and count, then the bar with its tier counts beside it. The
   tick box shows on hover, and on every row once any Service is ticked.
3. Above the list, "Tick Services to Scan" with "Tick all". With ticks it reads "N ticked" with "Tick all" and
   "Clear".
4. The Scan button reads "Scan checkout-api · 24h" for one, "Scan 3 ticked · 24h", or "Scan 12 Services · 24h".
5. Superseded by monitor-source-tabs items 2 and 3: the status sentence and the source tabs say when each source was
   last scanned; Scan notes and failures open from the sentence.
6. Superseded by monitor-source-tabs item 5: the toolbar holds the severity switch with counts, the search box, the
   Services menu and the Closed switch.
7. Superseded by monitor-source-tabs item 8: the Alerts are table rows titled by Route.
8. Superseded by monitor-source-tabs item 5: the table lists highest tier first with no group heads; a tier tab shows
   one tier.
9. Superseded by workspace-inbox-and-pr-cockpit item 9: a pull request row shows the time since opened, and the full
   date is in the tooltip.
10. Superseded by workspace-inbox-and-pr-cockpit item 2: a Session row shows the time since last active, and the hover
    card and the tooltip give the start and last-active dates.

## Not required

- **Session day groups**: Sessions keep their last-active order with no Today and Yesterday heads.

## Safety

No change.

## UI

Loading, empty and error states are unchanged.

## Seams

- **Browser** (`frontend/e2e/monitor-lists.spec.ts`): 2 to 4.

## Out of scope

- Merged date on closed pull requests.
