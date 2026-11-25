# Remove the Permissions page

**Status:** shipped
**Design:** none. A page goes; two status lines move into the Setup agent tab.

## Problem

The Permissions page holds a Full Disk Access row, a Start at login row, a Keychain row and the Run sandbox status, and the operator reaches none of them often. The sidebar item and the page are weight for little use.

## Behavior

1. The sidebar has no Permissions item and `/permissions` is not a route. A visit to it opens Setup agent.
2. Setup agent shows the Full Disk Access status as one line: "Full Disk Access: on" or "off", with Open Settings when off. The hint "Turn on Full Disk Access in Permissions first" says "Turn on Full Disk Access first" and points to that line.
3. Setup agent shows the Run sandbox status as a second line, on or unavailable with the page's tooltip text. It is read-only, as on the page: no Setting turns the sandbox off.
4. Start at login and Keychain have no row. Start at login is not shown; the operator changes it under App Background Activity in macOS Login Items.
5. The statuses still call the endpoints the page called. The backend does not change.

## Settled

- **Keychain row**: dropped. It only said that macOS asks each time, and the console cannot change that.
- **Start at login**: no row after this change. The row's "Open Login Items" button goes with it. The endpoints stay, unused.
- **Keychain handover refusal**: still shown, as an alert under the two lines, until the next start. It sits on the page that held the Keychain row, and the operator has no other place to see it.
- **Check again**: gone with the page. The Full Disk Access line reads again when the window regains focus, as on return from System Settings.
- **Terminal running**: the lines sit beside the Welcome card and go while the terminal runs, as the aside does.

## Not required

- **A control for Start at login in the console**: the operator uses macOS Login Items.

## Safety

No change. The Run sandbox stays on by default ([ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md)) and the status reads the same endpoint.

## UI

Setup agent tab only. The sandbox status shows its loading and error states as the page did.

## Seams

- **Browser** (`frontend/e2e/shell.spec.ts`): 1 to 3.
- **Frontend component**: 2 and 3.

## Out of scope

- A Start at login control.
