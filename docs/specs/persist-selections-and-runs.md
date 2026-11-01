# Persist selections and runs

**Status:** draft
**Design:** none; every page in `design/ops-console.html` keeps its layout. This spec changes what each page remembers, not what it draws.

## Problem

The operator picks a Service on the Monitor, ticks three Services to Scan, switches to Workspace to check a pull request, and comes back. The picked Service and the ticks are gone. The same happens on a reload, and closing the tab loses the sign-in as well: reopening the console asks for `ops-console open` again. Every page holds what the operator picked only while it is on screen, so moving around the console keeps undoing their work.

Agent runs already go on when the browser reloads or closes, because the daemon runs them. They do not survive the daemon itself stopping: an update, a crash, or a dev reload fails every running Session, Verification, Fix, Agent Review and Scan with `interrupted`, and ends the Setup agent's terminal. The operator has to notice and start each one again.

## Behavior

### Remembered view

1. On every page, what the operator picks stays picked until they change it: through switching pages, reloading, and closing the tab and opening the console again. Pages that have nothing to pick are left as they are.
2. The picked item of a page lives in the address, so Back and Forward step through picks and a copied address opens the same item:
   - Monitor: `?service=<name>&alert=<id>`.
   - Workspace: `?tab=sessions&session=<id>` or `?tab=pulls&pr=<repo id>/<number>`.
   - Dev tools: `?session=<id>`, or `?draft=<id>` for a new terminal.
   - Integrations: `?open=connector:<id>` or `?open=mcp:<name>`.
   - Connections: `?connection=<id>`, or `?connection=new`.
   - Setup agent: `?terminal=<id>`.
3. Every other choice on a page is kept in the browser's local storage for that page:
   - Monitor: severity tab, Closed, ticked Services, the Services filter, how many logs are shown, the Alert's JSON view and its picked Report version. Range and status codes are kept as today.
   - Workspace: Mine or All, the pull request search, each "show all" in the Sessions list, the branch picked for a new Session, a pull request's picked file, split and full view, and which files are open. Viewed files and folded groups are kept as today.
   - Dev tools keeps its open terminals as today. Integrations, Connections and Setup agent have nothing to keep beyond their pick.
4. Typed drafts are kept per target until they are sent or cleared: a pull request comment by file and line, a reply by thread, a Session's message box by Session, a Dev tools question by terminal (kept as today), a Setup agent line by terminal (kept for the browser's life today, now on disk), and a filter or search box by page.
5. Clicking a page in the sidebar opens it at the address it had when the operator last left it. Opening the console at `/` lands on the last page visited, `/monitor` the first time.
6. A Workspace link from the Monitor that names a Session opens that Session and keeps `?session=<id>` in the address instead of clearing it.
7. A picked item that no longer exists, such as a deleted Session, a dismissed and purged Alert, or a removed Connection, leaves the page in its nothing-picked state. The pick is dropped from the address and storage, with no error shown.
8. A ticked Service that is missing from the current range stays ticked but is not counted or scanned. It counts again when a range lists it. Untick clears every tick, listed or not.
9. A stored value that fails to read, from an older build or a hand edit, is ignored and the page shows its default.
10. Menus, confirm steps (Delete, Merge, Remove), dropdowns and "Copied" flashes start closed after a reload or a page switch.

### Sign-in

11. The sign-in token is kept in local storage, so closing the tab and opening the console again lands where the operator left off. A daemon that answers `unauthorized`, such as after a reinstall that made a new token, clears the stored token and shows "Run `ops-console open` to sign in". Remembered views stay.

### Runs through a daemon restart

12. On daemon start, a Session left `working` resumes its run in the same Claude session with the same account, model, effort and Access mode. Its transcript shows a `step` part "Resumed after the console restarted" before the new output. A limit or sign-in failure on resume follows Auto-switch as any run does (`02-settings-agents` Behavior 26 and 26a).
13. A Session left `waiting_approval` resumes the same way. Its pending Approval becomes `expired` with `interrupted`, and the resumed run asks again, which creates a new Approval. Nothing the agent asked to do runs without an Approval.
14. A Session left `waiting_input` resumes and asks its question again.
15. A `running` Report resumes its Verification in the Alert's Session. Its steps so far are kept, and the Alert stays `verifying`.
16. A `running` Fix continues from its current stage. Stages already done are not repeated, and a ticket that exists is not created again (`08-monitor-dashboard` Behavior 22).
17. A `running` Agent Review resumes in its Session and posts its findings when it finishes, with the same-line rule as before (`07-workspace`).
18. A `running` Scan starts over with the same Services, range, status codes and envs under the same Scan id. Rows the first attempt wrote are replaced, and Alerts dedupe by Fingerprint, so no Alert is made twice.
19. A Setup agent terminal open when the daemon stopped is started again in the same working folder with `claude --resume <its Claude session id>`. The Setup agent page reattaches to it. A secret the agent was waiting for is asked for again; pending secrets the daemon held in memory are gone.
20. A run, Scan or Setup terminal resumes at most 3 times in a row. A daemon start that finds it unfinished a fourth time fails it as before: Session `failed`, Report `failed` with its Alert moved as in `08-monitor-dashboard` Behavior 13, Fix `failed` at its stage, Agent Review `failed`, Scan `failed` with `interrupted`, Setup terminal ended. The count goes back to 0 when the run finishes.
21. Two runs resume side by side, as two Sessions run side by side today. They wait for the daemon's start-up hook to finish, then begin before the port opens to the browser.
22. A browser that is open during the restart reconnects and shows the resumed runs streaming, with no reload.
23. A PROD Connection keeps its rules on resume: the resumed run gets the same MCP servers at the same Access Levels, read at resume time, so a Connection set to `none` while the daemon was down is left out.

### What must not regress

24. A browser reload, a page switch or a closed tab still never stops a run.
25. The page that loads first after a reload still shows within the current timings: no extra request waits before it draws, and local storage reads are synchronous.

## Settled

- **Address or storage**: the item a page shows (Session, pull request, Alert, Connection, Integration, terminal) goes in the address. Everything else that shapes the page goes in local storage. This keeps links and Back working, and keeps addresses short.
- **Scope of storage**: per browser profile, keyed by page. Two tabs share it; the last change wins, and the other tab reads it on its next load.
- **Validation**: each stored value is parsed with a schema; a failed parse means the default (Behavior 9).
- **Transient UI**: menus, confirm steps and flashes are not remembered (Behavior 10). A confirm step for a destructive action never reopens on its own.
- **Resume order**: Setup terminals, then Sessions with their Reports, Fixes and Agent Reviews, then Scans, all inside the start-up hook (`01-base-daemon-setup`).
- **Resume prompt**: the resumed run gets one message telling it the console restarted during its last turn and to check what it finished before it goes on. The operator sees the `step` part, not that message.
- **Interruption count**: one counter on the Session, the Scan and the Setup terminal. A Report, Fix or Agent Review counts through its Session.
- **Pending Approval**: expires with `interrupted` and is asked again, rather than carried across (Behavior 13).
- **Claude session id for Setup terminals**: the daemon picks it and launches with `--session-id <id>`, so it can pass `--resume <id>` after a restart.
- **Setup terminal folder**: lives under the data dir by terminal id, so a restart finds it. Ending the terminal removes it.
- **Revised specs**: this replaces `01-base-daemon-setup` Behavior 27 (token storage), `02-settings-agents` Behavior 18 and the "Waiting through a restart" line, `08-monitor-dashboard` Behavior 26, the Agent Review start-up recovery in `07-workspace`, and the Setup terminal's end-on-restart in `05-settings-dev-tools`. `/ship` rewrites each in place.

## Not required

- **Live sync between tabs**: a pick in one tab shows in another only after that tab reloads.
- **Sync between browsers or machines**: picks stay in the browser that made them.
- **Scroll position**: lists open at the top after a reload; the picked row is in the address and highlighted, but the list does not scroll back to it.
- **Exact replay of a half-done tool call**: if the daemon stopped in the middle of a tool call, the resumed run decides from its transcript whether to call it again. The resume prompt tells it to check first.
- **Pending secrets across a restart**: the Setup agent asks again (Behavior 19).
- **Partial Scan results**: a restarted Scan reads everything again instead of continuing where it stopped.

## Safety

The agent's reach does not grow. A resumed run gets the same tools, Connections and Access Levels it would get if the operator sent a new message at that moment, read at resume time. A write on a PROD Connection still needs a new Approval: an Approval pending at the restart expires and is never carried over (Behavior 13). The agent still never merges (ADR 0002). The resume cap (Behavior 20) stops a run that crashes the daemon from restarting it forever.

The sign-in token moves from the tab's session storage to local storage, so it stays on disk in the browser profile. The daemon still listens on `127.0.0.1` only and still checks the token on every request and WebSocket (ADR 0003). A new token, after a reinstall or `ops-console open` with a fresh one, replaces it.

## Database

```sql
-- Daemon starts in a row that found this Session's run unfinished; 0 once a run finishes.
ALTER TABLE sessions ADD COLUMN interruptions INTEGER NOT NULL DEFAULT 0;

-- Daemon starts in a row that found this Scan running; 0 once it finishes.
ALTER TABLE scans ADD COLUMN interruptions INTEGER NOT NULL DEFAULT 0;

CREATE TABLE setup_terminals (
  id                 TEXT PRIMARY KEY NOT NULL,
  claude_session_id  TEXT NOT NULL,           -- passed as --session-id at launch and --resume after a restart
  account_id         TEXT REFERENCES claude_accounts (id) ON DELETE CASCADE,  -- config dir the CLI ran with
  model              TEXT NOT NULL,           -- Model
  effort             TEXT NOT NULL,           -- Effort
  interruptions      INTEGER NOT NULL DEFAULT 0,  -- as on sessions
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
```

Existing rows get `interruptions` 0. A Setup terminal open while the migration runs has no row, so it ends as it does today; terminals started after the migration get one. A row is deleted when its terminal ends.

## API

### `GET /api/terminals`

Lists terminals relaunched after a restart as well, with the same shape. No new field.

### WebSocket `session.updated`

No new field. A resumed Session moves from its stored state to `working`, which fires this event as any run does.

### WebSocket `scan.started`

Server to client, when a Scan starts over after a restart. Same payload as when the operator starts one; `scan_id` is the existing Scan's id.

## UI

- **Every page**: reads its remembered view on load before the first draw and writes each change as it happens. A pick that no longer exists falls back as in Behavior 7. Loading, empty and error states are unchanged.
- **Sidebar**: each item links to the page's last address (Behavior 5).
- **Monitor**: Service, Alert, severity tab, Closed, ticks, filter, log count, JSON view and Report version kept. While a Scan restarts after a restart, the Scan button shows "Scanning…" as for any running Scan.
- **Workspace**: tab, Session or pull request, Mine or All, search, file, split and full, open files and drafts kept. A resumed Session shows the "Resumed after the console restarted" step and streams on.
- **Dev tools, Integrations, Connections, Setup agent**: picked item in the address. Setup agent reattaches to a relaunched terminal and shows the resumed Claude conversation.
- **Sign-in**: closing and reopening the tab skips the sign-in panel while the token holds.

## Rejected

- **Keeping picks in SQLite through the daemon**: the same picks in every browser, but every page would wait on a request before drawing and every pick would need an endpoint. The operator works from one browser.
- **Only the address**: Back would step through every tick and tab change, and addresses would carry drafts.
- **Failing runs on restart, with the UI only reattaching**: the operator would still start each run again after every update and crash.
- **Carrying a pending Approval across the restart**: the agent's tool call waiting on it is gone with the old daemon, so approving it would resume a call nothing is waiting for. Asking again is simpler and just as safe.
- **Continuing a Scan from where it stopped**: needs a record of which Services were read; reading all of them again is cheap, and Fingerprints already dedupe.
- **No resume cap**: a run that crashes the daemon would crash it on every start.

## Glossary

- **Remembered view**: what the operator picked, ticked, typed or opened on a page, kept until they change it, through page switches, reloads and reopening the console.
- **Resume**: a daemon start continuing a run the last daemon left unfinished, in the same Claude session, at most 3 times in a row.

## ADR

- **Runs resume after a daemon restart**: a Session, Verification, Fix, Agent Review, Scan or Setup terminal left running continues on the next daemon start instead of failing. Work the operator started is not lost on an update or crash. The cost: a tool call cut off mid-way may run again, and a run that crashes the daemon would loop without the cap of 3. Hard to reverse once operators rely on it, and it reverses the fail-on-restart rule from `02-settings-agents`.

## Seams

- **Browser (Playwright e2e)**: Behaviors 1 to 11, 22, 24 and 25. Pick and tick on each page, switch pages, reload, close the context and open a new page, then check the picks, address, drafts and open panels. A stale pick and a bad stored value check fallbacks; a stored token skips sign-in.
- **Backend + SQLite (daemon restart on the same data dir, fake agent)**: Behaviors 12 to 21 and 23. Start a run, stop the app mid-run, start it again on the same data dir, then check the resumed state, the `step` part, the new Approval, the Fix stage, the Scan restart, the Setup terminal relaunch, the cap at 3 and the Access Levels read at resume time.

## Out of scope

- Live sync of picks between tabs and browsers: a later spec if the operator works across machines.
- Scroll position restore: later, per list, if long lists make it matter.
- Resuming a tool call exactly where it stopped: belongs to the Claude Agent SDK.
