# Session browser and processes

**Status:** shipped
**Design:** `design/session-browser.html`: the Browser panel in six states and the Terminals dock with the agent's Approval. It departs from every screen: neither `design/ops-console.html` nor `design/ops-console-sidebar.html` has a browser or a process panel.

## Problem

The operator wants to run a whole project in a Session: the frontend, the backend, a database, whatever the repo needs.
Then they want to see it work without leaving the console, and to tell the agent "test the checkout flow" and watch it
happen.

Today a run's commands are sandboxed and end with the run, so no server stays up. The agent says "open localhost:5173",
the operator finds the tab, comes back and reports what they saw. The agent cannot see the page, so it cannot check its
own UI change. Links in the transcript open a new tab and lose the Session.

T3 Code shows the page beside the conversation, runs terminals per thread and lets the agent drive the page. This spec
adds the same to a Session.

## Behavior

### The panel

1. A Session of kind `repo` or `anonymous` has a Browser button in its header. It opens a Browser panel beside the
   conversation, folding to a rail like the Changes panel. A `pr_review` or dev-tools Session has none. The panel's
   width and open state are remembered per browser.
2. The panel holds tabs, one page each. A new panel has one blank tab with the address field focused and the Local
   servers list below it (Behavior 11).
3. The toolbar has back, forward, reload (stop while loading), an address field, a device menu, "Open in a window" (35),
   "Open in external browser" and a close for the tab. The tab shows the page's title and favicon when it has them.
4. The operator's address field takes any `http` or `https` URL, `localhost:5173`, `127.0.0.1:3000/path` or a bare port
   (read as `localhost:<port>`). Other schemes (`file:`, `chrome:`, `javascript:`) are refused.
5. "Open in external browser" opens the current address in the operator's own browser, through the daemon, so it works the
   same in any browser the console is open in. With no page loaded it is disabled.
6. The page is a normal Chrome page and nothing is stripped from it: all CSS, JavaScript, fonts, images, frames,
   WebSockets (hot reload included), service workers, cookies and requests to any host work as in the operator's own Chrome.
   The page takes the operator's mouse, keys, scroll, paste and drag as a person's. A dialog the page raises shows as a line in the panel (an alert is accepted, a confirm or prompt is declined);
   a download is refused and says so. A file picker the page opens shows as a bar over the page with "Choose from this computer"
   and Cancel; the chosen files go to the page by their own names, and the page cannot read any other file.
7. Device menu: Fill (the panel's size, default), phone, tablet and desktop presets, a custom width and height, and rotate.
   A preset sets the page's size and device pixel ratio; the panel scales it down to fit. Fill takes the panel's pixel
   ratio, so text is sharp on a Retina screen. The choice is kept per tab until the tab closes.
8. A tab with no server on its port says "Nothing is listening on :5173" with Reload. A page that fails or crashes shows
   the error and Reload; the other tabs go on.
9. Each Session has its own cookies, local storage and cache, kept for as long as the Session exists and gone when it is
   deleted, or when the operator picks "Clear this Session's cookies". Two Sessions never share a login.
10. The panel lists the outside hosts the page called ("Called: fonts.example.com, api.example.com") for the operator to
    read. It blocks nothing.

### Local servers

11. The panel lists the Session's own servers: port, process name and the folder it runs in. A server started by one of
    the Session's processes (Behavior 17) is tagged with that process; one whose folder is in the Session's worktree, its
    Opened Repos or its output folder is tagged with the Session. A server of any other process on the Mac is not listed.
    A click opens one in the tab. The list refreshes when a process starts or ends, within half a second of a started server listening, and
    every 30 seconds while a panel is open. The console's own ports (4545, 4555, 4556) are never listed, nor is a port of the agent's own `claude` process, which runs the Run sandbox's network filter. A server that is the Session's but that no Session
    process owns, such as one started with `nohup` that outlived its terminal, shows a Stop button. Stop ends that process
    and what it started (by parent links, never by process group).
11a. When a process started while the Session is open begins listening, its page opens in the Browser panel with no
    click: the panel opens, and the page goes in the blank tab or a new one. A server already listening when the Session
    opened is not opened, and each port opens once. A process that listens but serves no page, such as a database, opens a
    tab that shows the error; the operator closes it.

### Links

13. A `http` or `https` link in a transcript, an Approval or an Agent's message to a loopback host opens in the panel when
    the Session has a Browser button and the link setting is "In the console". Any other link opens in the external browser.
    Cmd-click, Ctrl-click and the middle button always go external. The setting is "In the console" (default) or "In the
    external browser", kept per browser, set from the panel's menu.
14. Files the Session wrote (the viewer's HTML preview) are unchanged: no script, no network.

### Session processes

15. A Session of kind `repo` or `anonymous` has a Terminals dock under the conversation and the panel. It opens from the
    header's Terminals button. The dock holds one terminal per process, each with its name, command, state (running, or
    exited with its code) and output, in the look of the Setup agent's terminal.
16. A Run menu in the dock lists the `scripts` of the worktree's `package.json` (`dev`, `start`, `test`, `build`, ...) and
    "New terminal". A script starts as `pnpm`, `npm`, `yarn` or `bun run <script>`, whichever lockfile the Repo has; a new
    terminal is a shell the operator types in.
17. The daemon runs each process as the operator, in the Session's worktree (or an Opened Repo's folder, picked in the
    Run menu), with the operator's login environment and PATH, outside the Run sandbox, as the Setup agent's terminal does.
    It runs until the operator stops it, the Session is deleted, or the daemon exits. When the folder's `.env` files name the host of a PROD Connection, the dock shows "This folder's .env names the PROD Connection <name>" over the process, and the agent's Approval says the same and shows as PROD. A process that exits stays listed with
    its code and its last output until closed. Restart starts the same command again.
18. Any number of processes run at once, so the frontend, the backend and the database of one project run side by side.
    There is no cap. Processes of different Sessions never share a folder, since each Session has its own worktree.
19. The terminal takes input, paste and resize. The daemon keeps the last 256 KB of each process's output, which the dock replays to a browser that opens late.
20. A daemon exit stops every process of every Session, process group and children included. A daemon killed with no chance
    to clean up leaves none behind either: the shell holds the terminal, and the terminal closing hangs up the shell and the
    processes it started. A process that ignores the hangup (`nohup`) is left running; it shows under Local servers with a Stop
    (11).

### The agent

21. A chat run the operator started in a Session with a Browser button has the console tools `browser_open`,
    `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`,
    `browser_evaluate`, `browser_console` and `browser_network`. They act on the Session's tabs, the same ones the operator
    sees, and a tab the agent opens appears in the panel at once, tagged `agent`. A job (Verification, Fix, Agent Review,
    Reply check, Comment pass, Playbook step) and a `pr_review` Session never have them.
22. `browser_open` takes a loopback URL only. An agent tool acts only on a tab whose address is on a loopback host: on a
    tab at another host it fails with "This tab is on <host>. Agent tools work on loopback pages." The operator moves the
    tab; the agent does not follow a link off loopback. The console's own ports are refused.
23. The browser tools ask for no Approval except `browser_evaluate`, which asks in every Access mode but `full` and shows the script.
    Each call is an Action Log row.
24. `browser_snapshot` returns the page as an accessibility tree with a reference per element; click, type and press take
    that reference. `browser_screenshot` returns an image at the page's CSS size, whatever the viewer's screen, in the transcript and saves nothing else. `browser_console` and
    `browser_network` return the last 200 entries of the tab, redacted as an Action Log row is.
25. While the agent acts, the panel shows "Agent is using this tab". The operator's own input goes through at once and the
    agent's next call sees the changed page. A Stop on the run ends the call in flight.
26. The same chat has `start_process` (name, command, optional folder), `process_output` (name, last N lines, up to 500) and
    `stop_process`. `start_process` raises an Approval in every Access mode but `full`, showing the exact command, the
    folder and the line "Runs as you, outside the sandbox, with this Repo's environment". Only a yes has the daemon start it,
    as Behavior 17. `process_output` and `stop_process` of the Session's own processes ask for nothing.
27. Asked to "run the project and test the login flow", the agent starts the processes it needs (each asks once), waits for
    the server to listen, opens the tab and drives it, with the panel and the dock open for the operator to watch. A test
    runner's own browser (Playwright, Cypress) runs in the agent's sandbox, headless; the panel does not show it.

### Starting and stopping the browser

28. The daemon starts Chrome when a first tab opens, and not before. It uses the Google Chrome installed on this Mac,
    headless. Chrome missing: the panel says "Google Chrome is needed", the External button, the Terminals dock and every
    link setting still work, and the agent's browser tools are not offered. `OPS_CONSOLE_CHROME_PATH` names another build.
29. A Chrome that an earlier daemon left behind when it was killed is ended when the next daemon starts: any process whose
    command line names a profile folder under the data folder's `browser/` folder.
30. A Session's Chrome with no viewer on any tab and no agent call for 10 minutes closes with its tabs. Closing the last tab leaves it running for the next tab, until that idle time ends it. Its cookies stay in the Session's profile folder. Deleting a
    Session closes its tabs and stops its processes. The daemon exiting kills Chrome. A daemon start finds no Chrome of a
    previous run.
31. Two browsers open on one Session see the same tabs and terminals. A tab shows the size of whichever browser sent input
    last. A browser that takes over sends its first click, key or scroll to the page it was shown; the page takes its size
    after that.
32. A reload of the console page reopens the panel and the dock on the same tabs and processes. A daemon restart closes both;
    the panel opens blank and the dock lists the processes as stopped, with Restart.

### A tab in a window of its own

35. The toolbar's "Open in a window" button opens the current tab in a popup window of the operator's own browser, at
    `/browser-window/<session id>/<tab id>`. The address holds no token: the window is the console's own origin and
    reads the token from local storage, as the panel does. It is disabled with no tab. A second click on the same tab
    brings that window forward. A browser that blocks the popup shows "The browser blocked the window. Allow pop-ups for
    this page." under the toolbar.
36. The window has the panel's toolbar (back, forward, reload, address, device menu, External) and the drawn page, with
    no tab strip, no window button and no "..." menu. The page takes the window's size once the operator clicks or types
    in it, and the window's title is the page's title. It is one more viewer of the tab (31): the tab is the same
    one the panel and the agent use, and the tab's input, address and history work from the window.
37. While a tab is in a window, the panel shows "This tab is open in its own window." with "Show the window" and "Bring
    it back", and draws no frames of it: one viewer draws the page, so the page keeps one size. The panel's other tabs are
    unchanged. When the window closes, or "Bring it back" closes it, the panel draws the tab again.
38. A window whose tab was closed says "This tab was closed.", and one whose Session was deleted says "This Session was
    deleted."

### Must not regress

33. A run's commands still reach only the Network allowlist, and a run's sandbox is unchanged: no host is added by the
    browser, and a process the operator starts is not a run.
34. `/ws` still sends server to client events only, and nothing but the token holder reaches the page stream or a terminal
    (ADR 0003).

## Settled

- **Server-side Chrome, not an iframe**: the page lives in the daemon, so any page loads (no `X-Frame-Options` or
  `frame-ancestors` wall), the agent and the operator drive the same tab, and the page is a real Chrome page. T3 Code's web
  mode works this way.
- **Chrome, not Chromium**: the operator's own Chrome, run through `playwright-core`. Chromium is 366 MB and would triple
  the release.
- **No page blocking**: the page may call any host, so the Session's frontend runs as it would in the operator's Chrome.
  The cost is stated in the ADR: the Network allowlist covers a run's commands, not the pages a run helped build.
- **The agent stays on loopback**: it opens only loopback pages and acts only on loopback tabs, so a steered agent cannot
  browse the internet through the daemon. A script it runs in a page asks first (23), the one tool that can make the page
  send data to a host the operator never named.
- **Processes outside the sandbox, as the operator**: a dev server needs a bound port, the project's databases and APIs, the
  operator's tools and a life longer than one run. The Run sandbox gives none. They run as the operator does in a terminal; only
  the operator starts one, or approves the agent's command each time. `allowLocalBinding` is not added to the sandbox.
- **Stream**: frames go to the panel over a WebSocket of their own, `/browser/:tabId`, behind the same token check as
  `/terminals/:id`. Input comes back on it. Process output has its own, `/processes/:id`. `/ws` is untouched.
- **Sharp frames**: Chrome's screencast makes no frame with more pixels than its screen has, and a headless screen is 1x.
  Chrome starts with `--force-device-scale-factor=2`, so a Retina panel gets 2x frames. Each tab sets its own device scale,
  so a page still lays out at its CSS size and a 1x viewer's frames stay at 1x.
- **Frame rate**: the installed daemon runs under launchd, and Chrome inherits its priority. With no `ProcessType` in the
  plist, a panel page ran at 20 to 30 frames a second with gaps over 50 ms; with `Interactive` it runs at 57 to 60, the
  same as the daemon started from a terminal. Chrome's flags (GPU, frame-rate limit, backgrounding) and the screencast's
  quality, size and ack did not change the numbers in a terminal run, so none is set.
- **Isolation**: one Chrome and one profile folder per Session, tabs inside it, so a Session's cookies survive its Chrome exiting and no two Sessions share one.
- **Local servers**: read with `lsof` for listening TCP sockets on loopback, each process's folder, and the processes under
  the Session's own; only the Session's are returned.
- **Link setting**: a per-browser pick in the panel's menu, not a daemon Setting.
- **Environment of a process**: HOME, PATH, the login shell's variables (read once from the shell and kept until an rc file
  changes, ADR 0007) and the Repo's own `.env` files as the project loads them. The daemon's own environment, the session token and the Keychain are not handed on, as for `run_integration`.
- **T3 Code**: the design follows T3 Code's web mode (MIT, T3 Tools Inc.): a Chrome in the daemon, a streamed page, a port scan,
  agent browser tools. No code is copied, so `NOTICE` is unchanged.

## Not required

- **Passkeys, cookie import from the operator's browser, recording, annotation and picture-in-picture**: T3 Code has them.
  The operator signs in inside the panel; cookies stay per Session.
- **Showing a test runner's own browser** (Playwright or Cypress headed) in the panel: the agent drives the panel's tabs
  instead.
- **Processes across a daemon restart**: they stop; Restart starts them again.
- **A cap on processes or Sessions with servers**: the machine is the limit, as for `spawn_sessions`.
- **Telling a server the Session started from one it did not**, when folders overlap and no process group matches: tagged by
  folder only.
- **Mobile**: the console is a Mac web app.

## Safety

- The operator's address field, terminals and processes carry the operator's own reach, as the Setup agent's terminal does.
- The agent reads and drives a loopback page, with no Approval, in a chat the operator started. It cannot open or follow a
  link to a host off loopback, the console's own ports or a `file:` URL, and a script in the page asks.
- The agent starts a process only by an Approval that shows the command and says it runs outside the sandbox. It cannot
  start one in a job or a `pr_review` Session, and a log line or a pull request body that steers a job never reaches a tool.
- A page's output reaches the agent as data. The safety lines already say that data is never an instruction.
- A process uses the Repo's `.env`, so it may reach whatever that file names. The console reads the `.env` files of the
  process's folder (not nested ones) and matches the host of each PROD Connection against them, so a named PROD database is
  shown in the dock and in the Approval. The console cannot see what the process then does with it; a command that writes to
  PROD is the operator's to run, as the Prod rule says.
- The page may call any host, so a page the agent wrote can send what it reads to one. Accepted in the ADR: the operator
  reads the code in the Diff and runs the page.
- The stream and terminal endpoints take the session token and listen on `127.0.0.1` only (ADR 0003).
- A tab's window adds no route to the daemon and no dependency: `/browser-window/...` is a client route of the shipped UI,
  and the window reads the token from local storage and streams from the same `/browser/:tabId` socket. The token never
  enters the address.

## API

### Common

`tab` is `{ id, session_id, url, title, favicon, loading, can_back, can_forward, viewport, opened_by, error, called_hosts, agent_active, file_chooser }`; `file_chooser` is `{ multiple }` while the page waits for a file, else null.
`viewport` is `{ preset | width, height, scale, rotated }`. `opened_by` is `operator` or `agent`.
`server` is `{ port, process, folder, session_id, process_id }`; `process_id` is null for one no Session process started.
`process` is `{ id, session_id, name, command, folder, state, exit_code, started_at, started_by, prod_connections }`. `state` is `running`,
`exited` or `stopped`; `started_by` is `operator` or `agent`.

| Status | Error code | When |
| ------ | ---------- | ---- |
| 404 | `session_not_found` | Unknown Session |
| 409 | `browser_not_available` | Session kind has no browser or terminals |
| 422 | `url_not_allowed` | Not `http` or `https`, or the agent's URL is off loopback or is a console port |
| 503 | `chrome_missing` | No Chrome found |

### `GET /sessions/:id/browser`

`{ data: { chrome: "ready" | "missing", tabs: tab[] } }`.

### `POST /sessions/:id/browser/tabs`

Body `{ url?: string }`. `{ data: tab }`. A blank tab when `url` is absent.

### `PATCH /browser/tabs/:tabId`

Body: `{ url?, action?: "back" | "forward" | "reload" | "stop", viewport? }`. `{ data: tab }`.

### `DELETE /browser/tabs/:tabId`

204.

### `POST /browser/tabs/:tabId/external`

Opens the tab's address in the operator's browser. 204. 409 `nothing_loaded` for a blank tab.

### `POST /browser/tabs/:tabId/files?name=`

Keeps one file for the page's open file picker; the body is the file. 201 `{ data: { id, name, size } }`. 409
`invalid_state` when the page is not asking for a file.

### `POST /browser/tabs/:tabId/files/choose`

Body `{ ids: string[] }`, the staged files in order; none cancels the picker. 204. 400 for an id not staged on this tab.

### `POST /sessions/:id/browser/clear`

Clears the Session's cookies and storage. 204.

### `POST /sessions/:id/local-servers/:port/stop`

Stops the server on `port` when it is this Session's. 204. 404 `not_found` for a port that is not this Session's.

### `GET /sessions/:id/local-servers`

`{ data: { servers: server[] } }`.

### `GET /sessions/:id/scripts`

`{ data: { runner: "pnpm" | "npm" | "yarn" | "bun", scripts: [{ name, command }] } }` from the worktree's `package.json`.

### `GET /sessions/:id/processes`, `POST /sessions/:id/processes`

`POST` body `{ name, command?, script?, folder? }`; `script` or `command`, not both; none for a new terminal. `{ data: process }`.

### `POST /processes/:id/stop`, `POST /processes/:id/restart`, `DELETE /processes/:id`

`{ data: process }`; `DELETE` closes an exited one and answers 204.

### WebSocket `/browser/:tabId`

Raw stream behind the token. Server to client: a binary message per frame (the page's CSS width and height as two big-endian uint32, then the JPEG, which has
those sizes times the page's device scale), `tab` (a changed `tab`; it carries `called_hosts` and `agent_active`), `dialog`.
Client to server: `input` (pointer, key, wheel, text), `resize` (`width`, `height`, and `dpr`, 1 to 3, default 1: the viewer's
pixels per CSS pixel, which a Fill page takes as its device scale), `focus`. `closed` then the socket closes.

### WebSocket `/processes/:id`

Behind the token. Client to server: `input` (raw data), `resize` (cols, rows). Server to client: `output` (the replay, then live
chunks) and `exit` (code). It replays what the process printed to a browser that opens late.

### WebSocket `/ws` events

Server to client: `browser.tabs_changed` and `browser.servers_changed` (`{ session_id }`), `process.changed` (`{ session_id,
process }`), `process.removed` (`{ session_id, process_id }`), so the Browser button's dot and the dock update without the panel open.

## UI

The Browser panel, a tab's window (the toolbar and the page, no sidebar), the Terminals dock, the Browser and Terminals buttons in the Session header (Workspace). States: no
Chrome, loading, blank tab with the Local servers list, no server for the Session, called hosts, crashed, "Agent is using this tab",
the page stream lost (a notice over the last frame while the panel reconnects), a tab in a window ("This tab is open in its own window."), a window whose tab or Session is gone;
the dock with no process, a running one, an exited one, an Approval card for the agent's `start_process`. The link menu holds
"In the console" and "In the external browser". Departure: neither design file has a browser or a dock, so the mock is new
(`design/session-browser.html`), and the window and its panel placeholder are not in it.

## Rejected

- **An iframe of the dev server**: pages that refuse framing do not load, and the agent cannot see or drive the page.
- **Playwright's Chromium, bundled or downloaded**: 150 to 366 MB, a download host for the allowlist and a progress state,
  where the operator already has Chrome.
- **Blocking or allow-on-click for the page's outside hosts**: pages look broken until the operator clicks, and a dev
  server's fonts, CDNs, analytics and sign-in each need a click. The operator asked for no blocking.
- **Loopback only for the operator's address field**: the operator may open a staging site as in any browser; only the
  agent is held to loopback.
- **The agent starts servers inside its sandboxed run**: needs `allowLocalBinding` and every API and database host on the
  Network allowlist, and the servers end with the run, so no project stays up.
- **An Approval on every browser tool call**: it would stop the agent on every click. The reach is a loopback page the
  operator can watch. Only `browser_evaluate` asks.
- **A daemon Setting for the link target**: the daemon would hold a per-browser preference no other code reads.

## Glossary

- **Browser panel**: The panel beside a Session's conversation that shows pages from the Session's Chrome. Each tab is one
  page. The operator and the agent drive the same tabs.
- **Local server**: A Session's process listening on a loopback port, with its port, name and folder. Other listeners on the Mac are not shown.
- **Session process**: A command the daemon runs for a Session, as the operator and outside the Run sandbox, in the
  Session's worktree: a dev server, a database, a test watch, a shell. The operator starts it, or approves the agent's
  `start_process`. It runs until stopped, the Session is deleted or the daemon exits. Shown in the Terminals dock.
- **Link target**: Where a link opens: "In the console", the Browser panel, or "In the external browser". Set per browser.

## ADR

- **A Session's pages call any host, and its processes run outside the sandbox**: the Browser panel is a real Chrome page
  with no blocking, and a Session process runs as the operator, started by the operator or by an Approval of the agent's
  command. The Network allowlist (ADR 0006) covers a run's commands, not what these two reach. The agent stays on loopback
  pages, and only the operator's click or yes starts a process. Hard to reverse because chats and Playbooks come to rely on
  it; surprising because the daemon runs a browser and long-lived processes; a real trade-off against the sandbox. ADR 0006
  records the exception.

## Seams

- **Backend + SQLite** (`browser.test.ts`, a real Chrome from `OPS_CONSOLE_CHROME_PATH`, a small server in the test):
  1, 2, 4, 6 to 10, 21 to 25 (25 with a fake page and a signal), 28 to 32, 34. The URL checks (4, 13's classification, 22) run with
  no Chrome. `browser-orphans.test.ts`: 29.
- **Backend + SQLite** (`session-processes.test.ts`, real child processes): 15 to 20, 26, 33; `process-prod-env.test.ts`: 17 and 26's PROD line; `process-hangup.test.ts`: 20; with `local-servers.test.ts`
  (a real listening socket): 11, 12, and the Stop of a leftover server.
- **Browser** (`frontend/e2e/session-browser.spec.ts`, a real daemon and Chrome): 1 to 3, 5, 6, 8, 11 (Stop), 15 to 17 (Run menu, Restart, Stop, Close), 21, 26, 27, 28, 32, and the PROD warning of 17.
- **Browser** (`frontend/e2e/skill-kinds.spec.ts` pattern): 13's setting and Cmd-click.
- **Browser** (`frontend/e2e/session-browser-window.spec.ts`, a real daemon and Chrome, a popup of the test's browser): 35 to 38.

## Out of scope

- Inspecting the page (elements, console and network, as Chrome's DevTools shows them): waits on where the DevTools
  frontend comes from. The official `chrome-devtools-frontend` package is source that needs Chromium's own build tools,
  and the prebuilt packages are an unmaintained repackaging with no licence file.
- Recording, annotation, element picking and picture-in-picture: a later spec, from T3 Code's `Annotation` and `Recording`.
- A Run button that detects a Repo's full stack (frontend, backend, database) and starts all at once: the operator picks
  scripts, or the agent starts them, one Approval each.
- Showing a test runner's own browser in the panel.
