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

A steered chat can read a loopback page and click in it. The pages it reaches are the operator's own dev servers.

Chrome missing leaves the panel with an explanation and the external-browser button; the Terminals dock and the agent's
process tools still work.
