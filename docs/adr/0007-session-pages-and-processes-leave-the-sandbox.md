# A Session's pages call any host, and its processes run outside the sandbox

A Session has a Browser panel and a Terminals dock. The panel runs the operator's own Google Chrome in the daemon, headless,
one profile per Session, and draws it in the page. It blocks nothing: CSS, scripts, fonts, frames, WebSockets and requests
to any host work as in the operator's own Chrome, so a frontend the Session runs behaves as it will in production. The
dock runs a Session process: a command the daemon starts as the operator, outside the Run sandbox, in the Session's
worktree, with the environment the operator's login shell builds, until the operator stops it, the Session is deleted or
the daemon exits. A frontend, a backend and a database run side by side.

The daemon reads that environment once per folder, in the background, by running `$SHELL -ilc 'env -0'`, and reads it
again when an rc file or one of the folder's version files changes. A command then runs as `$SHELL -c` with the saved
environment, so PATH, nvm, mise and the like resolve as in the operator's terminal without the 0.6 to 0.8 seconds the
rc files cost on every start. Until the first read of a folder has finished, a command runs as `$SHELL -ilc`. A terminal
the operator types in is always a login shell.

The operator starts a process, or approves the agent's `start_process` call, which shows the exact command and says it
runs outside the sandbox, in every Access mode but full. The agent drives the panel in a chat the operator started with the
`browser_*` tools, with no Approval, but only on loopback pages (`localhost`, `127.0.0.1`, `::1`, not the console's own
ports); it opens no other host and acts on no tab that has left loopback. `browser_evaluate` asks in every Access mode but full. No
job, no `pr_review` Session and no read-only run has these tools. The operator's own address field opens any `http` or
`https` page.

The panel's Inspect button opens Chrome's own DevTools frontend for a tab in a window of its own: the real frontend, built from a
pinned revision of its repository and served by the daemon. It talks to the page through a relay, a WebSocket route behind the
session token. Each window gets a CDP session of its own through Playwright, and the relay forwards the DevTools domains
(DOM, CSS, Runtime, Network, Debugger, Storage and the like) and refuses `Browser`, `Target`, `Fetch`, `Tracing`, `Input`,
`Emulation`, `Page` navigation and screencast, and the two methods that would read a file or stall requests. Chrome is never
started with a remote debugging port.

The Network allowlist ([ADR 0006](0006-agent-runs-sandboxed-by-the-os.md)) covers a run's commands. It does not cover what
a page or a Session process reaches.

## Considered Options

- **An iframe of the dev server**: pages that refuse framing do not load, and the agent can neither see nor drive the
  page. It lost to a page that lives in the daemon, as T3 Code does.
- **Block or allow per host, one click each**: the page's outside hosts would show "Blocked" until the operator allowed
  them. It lost because fonts, CDNs, analytics and sign-in each need a click and the page looks broken until then, which
  defeats running the real frontend.
- **Loopback only for the page and for the operator's address field**: the safest reach. It lost because the operator
  must test pages that call real APIs, and may open a staging site as in any browser. Only the agent keeps loopback.
- **The agent starts servers inside its sandboxed run** (`allowLocalBinding`, every API and database host on the
  allowlist): the servers end with the run, so no project stays up, and every host a project talks to joins the allowlist.
- **An Approval on each browser tool call**: it stops the agent on every click. The reach is a loopback page the operator
  watches, so only `browser_evaluate` asks.
- **Chrome with `--remote-debugging-port`, DevTools pointed at it**: no relay to write. It lost because any process on the
  Mac, the sandboxed agent included, could then drive the Session's Chrome and read its cookies around the mediated
  `browser_*` tools and the token (ADR 0003).
- **A DevTools frontend from a package or a Google host**: `chrome-devtools-frontend` on npm is 68 MB of source with no
  built files; `devtools-frontend-prebuilt` is a 2021 build by one person with no licence file; the copy at
  `chrome-devtools-frontend.appspot.com` is served file by file with no list to pin, and the release would wait on it.
  Building the pinned tag costs 3.4 GB of build tools and 8 to 19 minutes cold, depending on the network, then about 40 seconds of build; a cache keyed by the pin makes every later run free. Two clean builds gave the same hash, which the build checks.
- **An inspector written for the console**: a DOM tree and a console cover a fraction of DevTools.
- **DevTools on a second origin** (`localhost` beside `127.0.0.1`), the token passed by `postMessage`: a flaw in DevTools
  that a hostile page triggered could not read the token. It lost to a smaller design for now: the page is one the
  operator opened to inspect, and the frontend is Chrome's own. It stays open as a hardening step.
- **Playwright's Chromium, bundled or downloaded**: 150 to 366 MB for a browser the operator already has.
- **`$SHELL -ilc` for every command**: PATH is exactly what the terminal has, with nothing to keep in step. It lost
  because every process start and restart paid the full rc-file start-up, which the operator waits for. The saved
  environment matches a login shell's while the rc files and the folder's version files stay unchanged, and those are
  what a login shell reads.
- **One environment for the whole Mac**: a single read at daemon start. It lost because version managers such as mise
  set PATH from the folder's own files, so two folders of one Mac can have different `node`.

## Consequences

A page the agent wrote can send what it reads to any host. If text the agent read steers it, the page could post the
Repo's files or `.env` values to a host off the allowlist. The operator reads the code in the Session's diff and runs the
page; the console cannot stop this without blocking the page. A process runs with the Repo's own `.env`, so it may reach
whatever that file names. A variable that a shell function or a prompt hook exports only after a command runs is not in the
saved environment. The console shows a PROD Connection whose host that file holds, in the dock and in the agent's
Approval, but cannot see what the process does with it. A command that writes to PROD is the operator's to run, as the
Prod rule says.

The Inspector window runs on the console's origin and reads the token from local storage to open its socket, so a flaw in
DevTools that a hostile page could trigger would reach it. The relay narrows what the window can ask of Chrome; it cannot
narrow what the operator does in the page's own DevTools, such as running script or reading the cookies of every site the
Session visited.

A steered chat can read a loopback page and click in it. The pages it reaches are the operator's own dev servers.

Chrome missing leaves the panel with an explanation and the external-browser button; the Terminals dock and the agent's
process tools still work.
