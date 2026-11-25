# Console UI batch

**Status:** draft
**Design:** Sessions list, Session view, Pull requests page, sidebar, Accounts & Usage in `design/`. The Setup screens leave the design.

## Problem

The operator reported a set of faults and gaps in daily use:

- The Session browser does not behave like a normal browser: select all, copy, cut, undo, word moves, paste and the other key shortcuts do nothing or the wrong thing.
- A Session whose composer holds unsent text looks the same as an empty one in the Sessions list, and coming back to it shows no caret.
- The Sessions list is plain where T3 Code is informative: a pull request badge with no hover, no card on hover, no waiting state.
- The Pull requests page filters the activity with the operating system's dropdown, its scrollbar sits on the comments, the filter opens on All activity, and deleting a comment goes through a popover listing every comment of the operator's.
- Subagents show as a word in a side panel. T3 Code shows a count, per-subagent status and time, a hover card, a waiting line with an approval prompt, and a Lineage list.
- Small controls are too small to click, the sidebar order is not the order the operator works in, a prompt cannot be linked to, and the Setup agent is a second place to run Claude that an Anonymous Session should replace.

## Behavior

### Sidebar and controls

1. The Operate group lists Sessions, Pull requests, Monitor, Dev tools, in that order. The page the console opens on is unchanged.
2. The collapse button in the header of the Sessions list and of the Pull requests list is a 32 px square with an 18 px icon, and is as large on the folded rail.
3. The Connect group has no Setup entry, and no screen, button or link in the console names the Setup agent. `/setup` and `/permissions` open the Sessions page.

### Sessions list

4. A Session other than the open one whose composer holds text that was not sent shows a Draft badge on its row. The badge appears when the operator leaves the Session with text in the composer, and goes when the text is sent or cleared. It survives a reload, as the draft does.
5. Opening a Session puts the caret at the end of its draft in the composer, or in the empty composer, unless the focus is in another field. Coming back to a Session by switching Session or by switching browser tab shows the caret.
6. The pull request badge on a row is its own hover target. With one pull request it reads its number, and hovering shows one line: status icon, number, title. With more than one it reads `+N`, and hovering lists each pull request (status icon, number, title). While the pointer is on the badge the row's card stays closed.
7. Hovering the rest of the row opens the card: title, Repo, the machine the Repo is on, the branch, a warning line when the Repo's checkout is on another branch than the Session's, the model, then the pull request list.
8. A row whose agent is working shows a blue spinner and `Working` with the seconds under a minute and minutes after. A row whose agent waits on subagents shows a grey spinner and `Waiting` with the same time. An idle row shows the bare age (`19h`, `2d`).

### Session view

9. A user message has a Copy prompt link button beside Copy. It copies a link to that message in its Session; opening the link shows the Session with that message in view. The link carries no `#`.
10. A turn that spawned subagents ends with a row: a stack of up to three avatars and `+N`, `N subagents`, a sub-label (`N working`, `N done`, or both), the time since the first started, and a chevron. Expanded, it lists each subagent: avatar with a blue dot while running, title, status (`Running`, `Done`, `Failed`, `Stopped`), time, and for a spawned Session a link that opens it.
11. Hovering a subagent, in that list or in the Lineage list, opens a card: title, model, status with its time, and the Session's branch.
12. The Lineage heading reads `Lineage · N running` when any runs, with the subagents listed under it, each with the same status word and a blue dot while running. Its tray link names what it opens.
13. A Session waiting on subagents shows the waiting line above the composer: the count, the subagents' titles, an info icon and Stop. When a subagent's tool call needs an Approval, a line above it reads `Subagent needs approval`, names that subagent and has an `Open approval` button that scrolls to the Approval.
14. While a Session's messages load after a switch, the view shows `Syncing messages…` above the composer. A Scroll to end button shows when the view is scrolled up.

### Pull requests page

15. The Activity filter is the console's own dropdown (the one the Session composer menus use), never the operating system's control. It opens on Open threads, and the default is marked as such in the list. The choice is not kept across pages.
16. The page's scrollbar never draws over the comment box, the filter or a comment: the Overview panel keeps room on its right edge.
17. Each comment of the operator's own has a three-dot button. Its menu has Delete; choosing it asks to confirm, then deletes that comment. A comment that is not the operator's has no button. The thread-level menu is gone. Diff threads follow.

### Session browser

18. In the Session browser, with the page focused: select all, copy, cut, undo, redo, and the word and line moves (Option or Command with the arrows, with Shift to select) work on macOS as they do in Chrome. Copy and cut put the page's selection on the operator's clipboard.
19. Paste puts the operator's clipboard text into the focused field with Command+V or Control+V. Pasting an image or a file goes to the page when it holds a file field.
20. Typing with an input method (composed text, dead keys, emoji) arrives as typed.
21. Dropping a file on the page does not navigate the console. A drop on a file field attaches it.
22. A number key answers a pending question only when the page does not hold the focus.
23. A held key repeats in the page.
24. A page dialog (`alert`, `confirm`, `prompt`) shows in the console as it does today.

### Setup removed, Anonymous Session in its place

25. The Setup page, its terminal and the Setup agent are gone from the console, its tests, its design screens, its documents and its glossary terms.
26. An Anonymous Session's agent can do what the Setup agent did, with the same limits: test and save a Connection, list Connections, connect a Connector, add, list and authenticate an MCP Server, read a local file, folder or web page with secrets masked, read other apps' saved passwords with the operator's consent, and ask for a secret in a masked field that goes to the Keychain and never to the agent.
27. Each tool that saves, registers or reads a secret asks the operator for an Approval in every Access mode but `full`, naming what it will do. A masked field shows in the Session where the question would, and the agent is told only that a secret was stored.
28. Full Disk Access, Start at login and the Run sandbox status show on Accounts & Usage, in a section after Notifications, with the rows and wording the Setup page had. A refused Keychain handover shows there too.
29. A Session whose runs lack Full Disk Access says so in the Approval or the failure it already shows. Nothing else changes for it.

### What must not regress

30. Sessions, the Terminals dock, Dev tools, Playbooks, Connections, Connectors, MCP Servers and the Keychain wait banner behave as before.
31. The Session browser's mouse, wheel, plain typing, upload, resize and element pick behave as before.
32. Merge denials, the PROD write rule, `run_integration`'s list, Approvals and the console's own pushing do not change.

## Settled

- **One change**: the operator asked for one pull request. The streams are built in separate worktrees and merged in this order: Setup removal, Sessions list and view, Pull requests page, subagent display, Session browser.
- **Draft**: the draft is the text already kept per Session; the list reads it and listens for changes. No new store.
- **Caret**: focus moves on opening a Session, not on every render.
- **Subagents**: they stay subagents, not Sessions. The list links only a subagent that spawned a Session. Per-subagent Stop and subagent transcripts stay out ([session-panel-and-subagents](session-panel-and-subagents.md)); the Lineage rows have no stop square.
- **Subagent model**: read from the usage lines the daemon already keeps per subagent.
- **Approval**: an Approval records the subagent that asked, when one did.
- **Merging**: a pull request's merged state keeps showing as it does (the badge colour and the status word). T3 Code has no further merge indication to copy.
- **Browser clipboard**: the page's selection is read in the page and written by the console to the operator's clipboard. Headless Chrome has no clipboard of its own.
- **Moved to Accounts & Usage**: the section is named `On this machine`. Start at login is included where the daemon can read it.
- **Setup tools**: the services the Setup agent called stay (Connections, Connectors, MCP Servers, masking, the local reads). The Setup page, its terminal, the `mcp-setup` entry and the terminal gateway go.

## Not required

- **Autofill and native popups in the Session browser**: password and address autofill, the `<select>` list, the date picker, datalist and the context menu are browser interface the streamed Chrome does not draw. The operator sees the page's own markup only.
- **Browser find, zoom and address shortcuts**: Command+F, Command+L, Command+R and zoom act on the console's page, not the streamed one. The toolbar has Back, Forward and Reload.
- **Downloads** stay refused.
- **Windows and Linux keys** in the Session browser are not tested.

## Safety

An Anonymous Session's agent gains tools that write the console's own records and read local files. Each asks first (27), the secret never reaches the agent or the transcript, and the console masks what it reads. This reverses nothing in ADR 0002, 0004 or 0005; it moves where the Setup agent's tools live. ADR 0006 and 0007 lose their Setup agent paragraphs. The Run sandbox does not change. Nothing else changes in the agent's reach.

## API

### Common

No new error codes.

### `GET /terminals/keychain-wait`, `GET /terminals/keychain-handover`

Move out of the `terminals` module to a `keychain` controller at the same paths. Bodies unchanged.

### `GET /terminals/disk-access`, `GET /terminals/start-at-login`, `GET /terminals/run-sandbox`

Unchanged, kept for Accounts & Usage. `POST /terminals/disk-access/settings` and `POST /terminals/start-at-login/settings` stay.

### Removed

`POST /terminals`, `GET /terminals`, `DELETE /terminals/:id`, `POST /terminals/:id/secrets`, `POST /terminals/:id/tools/:tool`, the `/terminals/:id` WebSocket.

### Subagent in the Session payload

`subagents[]` gains `model` (string or null). An Approval gains `subagent_id` (string or null). Both nullable, so existing rows and clients read as before.

### WebSocket `browser` messages

Gains `clipboard` (server to client: `{ text }`, the page's selection after copy or cut), and from the client `paste` with `{ text?, files? }` and `compose` with `{ text }`. `key` gains `commands` (a list of Chrome editing commands).

## Database

The Approval's `subagent_id` is a nullable column.

```sql
ALTER TABLE approvals ADD COLUMN subagent_id TEXT;
```

Existing rows stay null.

## UI

- **Sessions list**: Draft badge, PR badge hover, row card, status chips.
- **Session view**: subagent row, hover card, waiting and approval lines, Syncing line, Copy prompt link.
- **Pull requests page**: dropdown, spacing, comment menu.
- **Accounts & Usage**: the `On this machine` section after Notifications.
- **Sidebar**: order, no Setup entry, larger toggles.
- Departures from the design are written back into `design/`.

## Rejected

- **A new draft store**: the text is already kept per Session.
- **Subagents as Sessions**: a larger change with its own spec.
- **A separate Setup page that is only a status card**: the operator asked for the module to go.
- **The operating system's `<select>`**: draws an unthemed popup the app cannot style.

## Glossary

- **Setup agent**: removed.
- **Handover refusal**: shows on Accounts & Usage, not the Setup page.
- **Draft**: text in a Session's composer that was not sent.

## ADR

- **0006 and 0007**: lose the Setup agent paragraphs, rewritten in place. No decision changes.

## Seams

- **Browser input encoding** (unit): 18 to 20, 23.
- **Browser daemon, real Chrome** (backend): 18 to 21, 24.
- **Session browser stream** (browser e2e): 18, 19, 22.
- **Sessions list and row** (frontend e2e): 4, 6, 7, 8.
- **Composer** (frontend e2e): 5.
- **Transcript** (frontend e2e): 9, 10, 14.
- **Subagent card, Lineage, waiting line** (frontend e2e): 10 to 13.
- **Subagent model and Approval** (backend + SQLite): 11, 13.
- **Pull requests page** (frontend e2e): 15, 16, 17.
- **Sidebar and shell** (frontend e2e): 1 to 3.
- **Anonymous Session tools** (backend + SQLite): 26, 27.
- **Accounts & Usage** (frontend e2e): 28, 29.
- **Regression**: 30 to 32 by the existing tests.

## Out of scope

- Per-subagent Stop, opening a subagent as a Session, subagent transcripts: a spec of their own.
- Autofill and native popups in the Session browser.
- The Linux port, which stays a draft on `linux-port` (#145); it rebases onto this once merged, since both touch the Permissions rows.
