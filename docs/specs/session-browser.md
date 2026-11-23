# Session browser and processes

**Status:** shipped
**Design:** `design/session-browser.html`: the Browser panel in six states, the Terminals dock in its states and the agent's Approval. It departs from every screen: neither `design/ops-console.html` nor `design/ops-console-sidebar.html` has a browser or a process panel.

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
3. The toolbar has back, forward, reload (stop while loading), an address field, a device menu, then one icon button per
   action, each named by its tooltip and its accessible name: "Open in a window" (35), "Pick an element" (45), "Inspect"
   (39), "Open in your browser" (an arrow leaving a box) and "Clear this Session's cookies" (a cookie with a small x). There is no "..."
   menu and no word beside a button. In a narrow panel the address field shrinks first, to 128 px, and then the buttons move
   together to a second row; none is hidden. The device button drops its label below 576 px. Each tab has its own close. The
   tab shows the page's title and favicon when it has them.
4. The operator's address field takes any `http` or `https` URL, `localhost:5173`, `127.0.0.1:3000/path` or a bare port
   (read as `localhost:<port>`). Other schemes (`file:`, `chrome:`, `javascript:`) are refused.
5. "Open in your browser" opens the current address in the operator's own browser, through the daemon, so it works the
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
   deleted, or when the operator presses "Clear this Session's cookies" and confirms. Two Sessions never share a login.
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
    click: the panel opens, and the page goes in the tab already on that site, which reloads, else the blank tab or a new one. A server already listening when the Session
    opened is not opened, and each port opens once. A process that listens but serves no page, such as a database, opens a
    tab that shows the error; the operator closes it.

### Links

13. A `http` or `https` link in a transcript, an Approval or an Agent's message to a loopback host opens in the panel when
    the Session has a Browser button. Any other link opens in the operator's own browser. Cmd-click, Ctrl-click and the
    middle button always go there. There is no setting for it. A page opened this way (a link, a Local servers row, a server that
    started) whose site (scheme, host and port) a tab already shows loads in that tab, which reloads, instead of a new tab.
    An address typed in the address field does not do this.
14. Files the Session wrote (the viewer's HTML preview) are unchanged: no script, no network.

### Session processes

15. A Session of kind `repo` or `anonymous` has a Terminals dock under the conversation and the panel, laid out as an
    editor's terminal panel. It opens from the header's Terminals button. Its bar holds only icons (each with a tooltip and
    an accessible name), left to right: the name of the selected process with a state dot (and "exited 1" or "stopped"
    once it ended; the tooltip has "Running · started 2m ago", the command and the folder), New terminal (+), a chevron
    menu for scripts and the folder (16, 17), Split, Restart (a turning arrow), Stop (a square) while the process runs
    or Remove (a bin) once it has exited or been stopped, then Maximize (Restore when maximized) and one "×" with the
    tooltip "Hide terminals. Processes keep running." The "×" hides the dock and ends nothing; Stop is the one way to end a
    process. Maximize grows the dock to 70% of the window and back; dragging the bar above it resizes as before.
    Split starts a shell in the same folder and shows it beside the selected one; the views of one split group sit side by
    side, the selected one marked with an accent line on top, and a click in a view selects it. From the second process on, a
    list of the processes shows at the right of the output, one row each with its state dot and name, and a tree line
    (┌ ├ └) joining the rows of a split group; a click selects a row and shows its group. A process that was never split
    shows alone. The split is the dock's own: it is not kept when the page reloads. A Session with no process shows "No
    terminals yet", one line on what a terminal is for and that it keeps running when the dock is hidden, a primary "New
    terminal" button, and the example "e.g. run your dev server. Its page opens in the Browser panel."
16. "New terminal" starts a shell the operator types in, and is never inside a menu. The chevron menu ("Scripts and folder")
    opens upward from the bar and lists the `scripts` of the worktree's `package.json` (`dev`, `start`, `test`, `build`, ...) and the
    other tools' commands the folder has. It appears once the folder lists a script or the Session has Opened Repos (17); with neither it shows no menu. A
    script starts as `pnpm`, `npm`, `yarn` or `bun run <script>`, whichever lockfile the Repo has.
17. The daemon runs each process as the operator, in the Session's worktree (or an Opened Repo's folder, picked in the
    chevron menu's "Run in" list, which names the folder new terminals and scripts run in), with the operator's login environment and PATH, outside the Run sandbox, as the Setup agent's terminal does.
    It runs until the operator stops it, the Session is deleted, or the daemon exits. When the folder's `.env` files name the host of a PROD Connection, the dock shows "This folder's .env names the PROD Connection <name>" over the process, and the agent's Approval says the same and shows as PROD. A process that exits stays listed with
    its code and its last output until the operator removes it. Restart starts the same command again.
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
    headless. Chrome missing: the panel says "Google Chrome is needed", links open in the operator's browser, the Terminals
    dock still works, and the agent's browser tools are not offered. `OPS_CONSOLE_CHROME_PATH` names another build.
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
36. The window has the panel's toolbar (back, forward, reload, address, device menu, Pick an element, Inspect, Open in your
    browser) and the drawn page, with no tab strip, no window button and no Clear cookies button. The page takes the window's size once the operator clicks or types
    in it, and the window's title is the page's title. It is one more viewer of the tab (31): the tab is the same
    one the panel and the agent use, and the tab's input, address and history work from the window.
37. While a tab is in a window, the panel shows "This tab is open in its own window." with "Show the window" and "Bring
    it back", and draws no frames of it: one viewer draws the page, so the page keeps one size. The panel's other tabs are
    unchanged. When the window closes, or "Bring it back" closes it, the panel draws the tab again.
38. A window whose tab was closed says "This tab was closed.", and one whose Session was deleted says "This Session was
    deleted."

### Inspecting a page

39. The toolbar's "Inspect" button (a `</>` icon, pressed while DevTools are docked) shows Chrome's DevTools for the current
    tab inside the panel, under the page by default, and a second press closes them. The button is disabled with no page.
    DevTools sit in an iframe of the panel at `/devtools-frontend/devtools_app.html?ws=<host>/browser/<tab id>/devtools`.
    The address holds no token: a script that runs in the iframe ahead of DevTools adds it from local storage when DevTools
    opens its socket. The tab strip, the address field and the other buttons stay as they were. A tab's own window (35) has
    the same button and dock. It works on any tab, loopback or not, as the address field does.
40. DevTools are Chrome's own frontend, built from a pinned revision of its repository and served by the
    daemon, not an imitation. Elements, Console, Sources, Network, Application, Memory and Security work on the tab's
    page: the DOM and styles, the console and a prompt that runs in the page, the page's scripts and breakpoints, its
    requests, cookies, storage and service workers. The panel goes on drawing the page and taking input while DevTools are
    open. Closing DevTools ends their session on the page, and a pause they left in the debugger lifts.
41. DevTools ask Chrome for nothing that drives the tab or reaches past it. A request for `Browser`, `Target`
    (except the page's own info), `Fetch`, `Tracing`, `Input`, `Emulation`, `Security` (except its events), `SystemInfo`,
    `Autofill`, or for `Page` navigation, screencast or scripts, and for `DOM.setFileInputFiles` and
    `Network.setRequestInterception`, gets an error reply, and the window stays open. Panels that need those do not work:
    device toolbar and the Rendering emulations, Performance recording, Lighthouse, Recorder, local overrides. DevTools
    sees the tab's page only: a frame that runs in another Chrome process and a worker are not inspected.
42. A tab takes three Inspectors at once (docked and in windows); a fourth is refused. An Inspector closes when its tab
    closes, when its Session is deleted, when Chrome stops and when the daemon stops.
43. Nothing leaves the Mac for DevTools: it loads only files the daemon serves, and its page policy allows no other host,
    so the field data and remote modules it would otherwise fetch from Google are never asked for. The agent has no tool
    for DevTools.

44. A header above the docked DevTools has the dock choices, "Dock to the bottom" and "Dock to the right" (the pressed one
    is the side now) and "Open DevTools in a window", then a close X. The side is kept per browser. "Open DevTools in a
    window" closes the dock and opens the tab's DevTools in a popup window of the operator's own browser, at the same
    address; a second Inspect docks them again and the window stays until it is closed. A browser that blocks the popup
    shows "The browser blocked the window. Allow pop-ups for this page." under the toolbar and leaves them docked. A
    draggable splitter between the page and DevTools resizes them, and so do the arrow keys on it; double-click resets.
    Each side has a smallest size for DevTools (160 px high, 240 px wide) and the page keeps at least 120 px high or 200 px
    wide. The size is kept per browser and side. The page measures only its own part of the panel: docking shrinks it,
    the viewer's Fill size and pixel ratio follow that part, the stream goes on, and closing DevTools gives the part back.

### Picking an element

45. The toolbar's "Pick an element" button (a pointer arrow, `aria-pressed` while on) toggles pick mode for the current tab. The
    button is solid and 20 px while on, and it stays on until the operator turns it off. It is disabled with no page, and works on any tab, loopback or not, as the address field does. The panel and a tab's
    own window (35) both have it. Pressing it again, pressing Escape, clicking or focusing the Session's message box in the console, or leaving for another tab turns
    the mode off. Picking an element does not. A page stream that drops and returns keeps the mode.
46. In pick mode the pointer is a crosshair and the element under it is outlined by Chrome's own overlay (a box with a card of its tag,
    size, accessible name and role), drawn into the page, so every viewer of the tab sees it. A click, a key and a paste do not reach the page; the
    wheel still scrolls it. A click on the page's own `html` or `body` picks nothing. The outline goes before the crop is
    taken, follows the pointer again after the click, and goes when the mode ends. The streamed page keeps its size and scale through every pick: the
    crop is taken by a screenshot that briefly resizes the view, and the frame Chrome sends for that size is never sent on. A crop that Chrome
    does not answer within six seconds, such as when the page reloads under it, is left out and the pick still completes.
47. A click takes the element at the point: its tag, a CSS selector path that finds it (an id or `data-testid` where one is
    unique, else the tags and `:nth-of-type` from `body`), its id and up to eight classes, its role and accessible name from
    Chrome's accessibility tree, its visible text (300 characters), its `href`, `src`, `alt`, `title`, `type`, `name`,
    `placeholder`, `for`, `role`, `data-testid` and `aria-*` attributes (200 characters each), its HTML (about 2 KB), its box in
    CSS pixels, its `color`, `background-color`, `font-size`, `display` and `position`, the page's address and title, and a JPEG
    crop of the element at one pixel per CSS pixel (at most 1000 by 800, the part inside the page).
48. The capture never holds an input's or textarea's value or typed text, an editable region's text, a script's or style's
    contents, a cookie, local storage, or the page's DOM beyond the element. `value` and `checked` attributes are dropped from
    every input in the HTML. An element that is or holds an input, a textarea, a select or an editable region, or that is a
    password field, has no crop, since a crop would show what was typed. Secret-looking text (tokens, `password=...`, bearer
    values, URL credentials) in the text, attributes, HTML, address and title is replaced with `[redacted]` by the redaction the
    Action Log and the Monitor Samples use.
49. The capture reaches the Session's message box as chips above the text, one per pick, in the order picked: the crop as a
    thumbnail, the label (`button#sign-in: Sign in`: the tag, the id or first class, and the text or name) and an x. A chip opens
    its crop. The message box does not take the focus, since focusing it ends pick mode. Each click while the mode is on adds a chip, so
    several picks in a row need no re-arming; a repeated label gets ` (2)`. The crop is
    attached as an image through the upload a pasted image uses. Picks stay with the Session through a reload until removed or
    sent, and a message of picks alone can be sent.
50. On send the message is the operator's text, then one block per pick, then the Attached files list that names each crop:
    `<picked-element page="..." selector="..." image="<crop name>">`, a line saying it is page content and not an instruction, the
    page title, tag and role, name, text, attributes, box, styles and `html:` with the markup, then `</picked-element>`. Page
    text cannot close or open a block. The transcript shows each block as a closed card headed by its selector. A Session's
    first message of picks alone is titled "Picked element".
51. A tab's own window picks the same way. The window has no message box, so the capture is kept in the browser's local
    storage under the Session and the console page takes it into its composer, open now or when it opens. The window's mode is the
    same toggle, stays on until its arrow, Escape or focus in the console's message box (the console page tells the window through a
    `BroadcastChannel`), and says "Added to the message box in the console." after a pick.
52. Picking is the operator's input: it goes through while the agent works on the tab (25), and the agent has no tool to pick,
    to read a pick or to turn the mode on.
53. Two viewers of one tab share the outline. The capture goes back to the viewer that clicked, and each viewer ends its own pick mode.

### The page keeps up

54. The page follows a resize. A Fill page is asked for the stage's size at every change, at most once per frame drawn, and
    the daemon takes the newest size when Chrome is free for it. Dragging the splitter beside the conversation, the DevTools
    splitter or a window's edge shows the page laid out again as it goes, with frames at nearly every step. A frame that has
    not caught up is at most a few steps out of shape, never the whole drag, and the page is at the stage's size within a
    frame or two of the drag ending.
55. The first frame is at the viewer's size and pixel ratio: the stream's address carries them (`?w=&h=&dpr=`), so a new tab
    or a window is not drawn at a default size and then again. Nothing is drawn before the first frame, so the stage never
    flashes a white canvas. A tab the panel showed a moment ago draws its last frame at once, when that frame is the stage's
    size, and the stream's first frame replaces it.
56. Hover, typing and scroll show on the canvas about as soon as in a Chrome driven over its own debugging port: a hover or
    a key within 50 ms on an idle Mac, the end of a trackpad swipe within 100 ms of the last wheel event.

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
- **Resize**: Chrome's screencast sends no frame for a page that has stopped changing, so a new size restarts it, and the
  restart sends the first frame of that size within about 30 ms. Sizes that arrive while one is applied replace each other, and
  the next waits for the frame of the last. Setting a size on every message, or never restarting the screencast, gave 13
  frames over a 40-step drag, or none; one size per frame gives about one frame per step. A screenshot of the page covers
  the case where no frame comes within 150 ms.
- **Frame rate**: the installed daemon runs under launchd, and Chrome inherits its priority. With no `ProcessType` in the
  plist, a panel page ran at 20 to 30 frames a second with gaps over 50 ms; with `Interactive` it runs at 57 to 60, the
  same as the daemon started from a terminal. Chrome's flags (GPU, frame-rate limit, backgrounding) and the screencast's
  quality, size and ack did not change the numbers in a terminal run, so none is set.
- **Isolation**: one Chrome and one profile folder per Session, tabs inside it, so a Session's cookies survive its Chrome exiting and no two Sessions share one.
- **Local servers**: read with `lsof` for listening TCP sockets on loopback, each process's folder, and the processes under
  the Session's own; only the Session's are returned.
- **Environment of a process**: HOME, PATH, the login shell's variables (read once from the shell and kept until an rc file
  changes, ADR 0007) and the Repo's own `.env` files as the project loads them. The daemon's own environment, the session token and the Keychain are not handed on, as for `run_integration`.
- **DevTools is Chrome's own frontend, built from source at a pinned revision**: the tab is a headless Chrome page streamed to
  a canvas, so Chrome's real DevTools frontend talks to it over the protocol. The daemon builds `ChromeDevTools/devtools-frontend`
  at a pinned tag with its own tools (`scripts/devtools-frontend.mjs`, pin and tree hash in
  `scripts/devtools-frontend.json`) and ships the files Chrome itself embeds, 862 files, 33 MB, 6.8 MB compressed. The
  build must reproduce the pinned hash. BSD-3-Clause, with the licences of its bundled packages in
  `devtools-frontend/LICENSES.txt` and `NOTICE`.
- **A relay with an allowlist, not a debugging port**: Chrome is never started with `--remote-debugging-port` or
  `--remote-debugging-address`, so no other process reaches the Session's Chrome. Each window gets a CDP session of its
  own through Playwright, behind the token, and the relay forwards the DevTools domains and refuses the rest.
- **Child targets stay out**: Playwright's session reaches one page, so the relay answers `Target.setAutoAttach` with an
  empty result and sends nothing on. DevTools then has one target, the tab's page.
- **T3 Code**: the design follows T3 Code's web mode (MIT, T3 Tools Inc.): a Chrome in the daemon, a streamed page, a port scan,
  agent browser tools, and the element pick. No code is copied, so `NOTICE` is unchanged.
- **Pick by the daemon, on the tab's own CDP session**: the page is a streamed canvas, so the panel cannot ask the page what is
  under the pointer. Hover and click go to the daemon over the page stream (`pick` messages). It finds the node with
  `DOM.getNodeForLocation`, outlines it with `Overlay.highlightNode` and reads it with one function run on the node. Measured: the
  overlay shows in screencast frames and in screenshots, so the panel draws no box of its own. `DOM.getNodeForLocation` and a
  screenshot clip count from the top of the document, so the daemon adds the scroll offset. The pick is the operator's, on the
  daemon's main session; the Inspector's relay still refuses `Overlay`, `Input` and the rest (41).
- **A pick is a chip, a block and an image**: the crop is an image attachment, because the agent reads images through the
  attachment path already. The element's text rides in the message, so the agent needs no Read to see it.
- **T3 Code's pick, compared**: T3 Code (Electron) injects an overlay script into the page. It outlines the hover, and on a click
  takes the page address and title, the tag, a selector, the HTML cut to 500 characters, the React component name with its source
  file and line, the styles as CSS text and a screenshot of the region; it also takes regions, drawings and style edits. Here the
  page lives in the daemon, so Chrome's overlay draws the outline and a node read takes the capture, with no script left in the
  page. The React component and source line, regions, drawings and style edits are not taken.

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
- An element pick goes into the operator's prompt, so its text, attributes, HTML, styles, address, title and crop leave the Mac
  for Anthropic as any message text and image do. 48 lists what is left out: typed values, password fields and a crop of a
  field, cookies, storage, and the page's DOM beyond the element. The operator sees each pick as a chip, can remove it before
  sending, and the transcript keeps the exact block. Page text in a block is data, and the block says so. The pick runs on a
  CDP session of the tab, behind the token, on the operator's hover and click; the agent cannot start it.
- The stream and terminal endpoints take the session token and listen on `127.0.0.1` only (ADR 0003).
- The Inspector reaches the page as the operator's own DevTools would: it runs script in the page, reads and
  edits its DOM, storage and cookies (the Session's profile holds those of every site it visited) and sets breakpoints.
  That is the operator's reach. The relay refuses what drives the tab or reaches past the page (41), including a file read
  through `DOM.setFileInputFiles`. The agent is not given DevTools.
- The relay is the only way in: a WebSocket route `/browser/:tabId/devtools` behind the same token check as
  `/browser/:tabId`, on `127.0.0.1` only, so ADR 0003 holds. Chrome has no debugging port, so a sandboxed agent run or
  any other local process cannot drive the Session's Chrome and its cookies around the mediated `browser_*` tools.
- DevTools runs on the console's origin and reads the token from local storage to open its socket. A flaw in DevTools that
  a hostile page could trigger would reach that token. Accepted in ADR 0007: the page is one the operator opened and
  chose to inspect, and the frontend is Chrome's own, at a pinned revision.
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

Raw stream behind the token. The address may carry `w`, `h` and `dpr`, the viewer's size, so its first frame is taken at it. Server to client: a binary message per frame (the page's CSS width and height as two big-endian uint32, then the JPEG, which has
those sizes times the page's device scale), `tab` (a changed `tab`; it carries `called_hosts` and `agent_active`), `dialog`.
Client to server: `input` (pointer, key, wheel, text), `resize` (`width`, `height`, and `dpr`, 1 to 3, default 1: the viewer's
pixels per CSS pixel, which a Fill page takes as its device scale), `focus`, `pick` (`action` is `start`, `end`, `hover` or `click`; the last two carry `x` and `y`
in the page's CSS pixels, and one from a viewer not in pick mode is dropped). To the viewer that clicked only: `picked` (`capture`: `{ page_url, page_title,
tag, selector, id, classes, role, name, text, attributes, html, box, styles, crop }`, `crop` a base64 JPEG or null) or `pick_failed` (`message`). `closed` then
the socket closes.

### WebSocket `/browser/:tabId/devtools`

Behind the token, as `/browser/:tabId`. The Chrome DevTools protocol as JSON text: requests `{ id, method, params }` from
the window, replies `{ id, result }` or `{ id, error: { code, message } }` and events `{ method, params }` from the
page. Refused: 404 for an unknown tab, 409 for a tab whose Chrome stopped, 429 when the tab has three windows. A method
the relay does not allow gets error `-32601` and the socket stays open; a request with a `sessionId`, or not a request,
gets `-32600`. The socket closes with `tab_closed` when the tab goes.

### WebSocket `/processes/:id`

Behind the token. Client to server: `input` (raw data), `resize` (cols, rows). Server to client: `output` (the replay, then live
chunks) and `exit` (code). It replays what the process printed to a browser that opens late.

### WebSocket `/ws` events

Server to client: `browser.tabs_changed` and `browser.servers_changed` (`{ session_id }`), `process.changed` (`{ session_id,
process }`), `process.removed` (`{ session_id, process_id }`), so the Browser button's dot and the dock update without the panel open.

## UI

The Browser panel, a tab's window (the toolbar and the page, no sidebar), the Terminals dock, the Browser and Terminals buttons in the Session header (Workspace). States: no
Chrome, loading, blank tab with the Local servers list, no server for the Session, called hosts, crashed, "Agent is using this tab",
the page stream lost (a notice over the last frame while the panel reconnects), a tab in a window ("This tab is open in its own window."), a window whose tab or Session is gone, the Inspect button with no page, pressed, and with a blocked popup; DevTools docked at the bottom and at the right;
the dock with no process, a running one, an exited one, the Run a script menu, a folder with no scripts, a narrow dock, an Approval card for the agent's `start_process`; pick mode with an element
outlined, and the composer with picked-element chips. Departure: neither design file has a browser or a dock, so the mock is new
(`design/session-browser.html`). The window, its panel placeholder, the Pick, Inspect, Open in your browser and Clear cookies icons and
the DevTools dock are not in it, and the mock still shows the old External button and "..." menu.

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
- **Starting Chrome with a remote debugging port for DevTools**: any process on the Mac, the sandboxed agent included,
  could then drive the Session's Chrome and read its cookies around the `browser_*` tools.
- **An inspector of our own** (a DOM tree and a console): it would cover a fraction of DevTools.
- **`devtools-frontend-prebuilt` from npm**: a 2021 build by one person, with no licence file and an old protocol.
- **The `chrome-devtools-frontend` npm package**: 68 MB of source, no built files and no build files.
- **Files fetched from `chrome-devtools-frontend.appspot.com`**: served one file at a time with no list and no hash to
  pin, and the release would wait on Google's host.
- **A link target setting** ("In the console" or "In the external browser"): the operator did not want it. A link to a loopback
  page opens in the panel, and Cmd-click goes to the operator's browser.
- **Drawing the outline in the panel from the node's box model**: it needs the viewer's scale and the page's scroll kept in step,
  and Chrome's overlay is already in the frames.
- **A script injected into the page to pick**: the page's own script could see and alter it, and a navigation drops it.

## Glossary

- **Browser panel**: The panel beside a Session's conversation that shows pages from the Session's Chrome. Each tab is one
  page. The operator and the agent drive the same tabs.
- **Local server**: A Session's process listening on a loopback port, with its port, name and folder. Other listeners on the Mac are not shown.
- **Session process**: A command the daemon runs for a Session, as the operator and outside the Run sandbox, in the
  Session's worktree: a dev server, a database, a test watch, a shell. The operator starts it, or approves the agent's
  `start_process`. It runs until stopped, the Session is deleted or the daemon exits. Shown in the Terminals dock.
- **Inspector**: One tab's Chrome DevTools, docked in the Browser panel or in a popup window of the operator's own browser,
  opened by Inspect. It reads and edits the tab's page through the daemon, which allows DevTools' own requests and refuses the rest.
- **Element pick**: The operator's click on an element of a tab's page in pick mode. It adds that element, with a crop of it, to
  the Session's message box, and the message then carries the element's selector, text, markup and styles in a delimited block.

## ADR

- **A Session's pages call any host, and its processes run outside the sandbox**: the Browser panel is a real Chrome page
  with no blocking, and a Session process runs as the operator, started by the operator or by an Approval of the agent's
  command. The Network allowlist (ADR 0006) covers a run's commands, not what these two reach. The agent stays on loopback
  pages, and only the operator's click or yes starts a process. Hard to reverse because chats and Playbooks come to rely on
  it; surprising because the daemon runs a browser and long-lived processes; a real trade-off against the sandbox. ADR 0006
  records the exception. It also records the Inspector: Chrome's own DevTools, reached through a relay on the
  console's token.

## Seams

- **Backend + SQLite** (`browser.test.ts`, a real Chrome from `OPS_CONSOLE_CHROME_PATH`, a small server in the test):
  1, 2, 4, 6 to 10, 21 to 25 (25 with a fake page and a signal), 28 to 32, 34. The URL checks (4, 13's classification, 22) run with
  no Chrome. `browser-orphans.test.ts`: 29.
- **Backend + SQLite** (`session-processes.test.ts`, real child processes): 15 to 20, 26, 33; `process-prod-env.test.ts`: 17 and 26's PROD line; `process-hangup.test.ts`: 20; with `local-servers.test.ts`
  (a real listening socket): 11, 12, and the Stop of a leftover server.
- **Browser** (`frontend/e2e/session-browser.spec.ts`, a real daemon and Chrome): 1 to 3, 5, 6, 8, 11 (Stop), 15 to 17 (the empty state, New terminal, Run a script, Hide, Stop, Restart, Remove, an exited process), 21, 26, 27, 28, 32, and the PROD warning of 17.
- **Browser** (`frontend/e2e/session-browser-pick.spec.ts`, a real daemon and Chrome): 3 (the icons and their names, no "..." menu, a
  narrow panel), 13, and 45 to 51 (the outline, a click that does not reach the page, the chips, several picks, send with the block
  and the crop, Escape, a tab's window).
- **Backend + SQLite** (`browser-pick.test.ts`, a real Chrome): 46 to 48 and 53: the outline shows and goes, the capture's fields, no
  click on the page, a scrolled page, the cuts, and no typed value, password, cookie or storage in anything returned.
- **Browser** (`frontend/e2e/session-browser-window.spec.ts`, a real daemon and Chrome, a popup of the test's browser): 35 to 38.
- **Backend + SQLite** (`browser-inspector.test.ts`, a real Chrome): 41, 42 and the relay of 40: an allowed round trip and events, the
  refused methods, one window to one tab, the pause lifted on close, closing with the tab, the Session and the daemon.
- **Browser** (`frontend/e2e/session-browser-inspect.spec.ts`, a real daemon, Chrome and the built DevTools): 39, 40, 43 and 44, with
  DevTools docked under and beside the page, the page's area and size message following, the splitter, the kept side, the
  window choice, and `1+1` answering 2 in the Console.

## Out of scope

- Performance recording, Lighthouse, the device toolbar and local overrides in the Inspector: they need `Tracing`,
  `Emulation` and `Fetch`, which the relay refuses (41).
- Recording, annotation (regions, drawings, style edits), a React component's name and source line for a pick, and
  picture-in-picture: a later spec, from T3 Code's `Annotation` and `Recording`.
- A Run button that detects a Repo's full stack (frontend, backend, database) and starts all at once: the operator picks
  scripts, or the agent starts them, one Approval each.
- Showing a test runner's own browser in the panel.
