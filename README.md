# ops-console

Ops Console is a local web app on top of Claude Code. It runs on your Mac, shows how your services are doing, and
lets a Claude agent work on your code and tools. The agent reproduces a failing route and writes a report. You read
it. Only after you confirm does the agent fix the code and open a pull request, and you merge it yourself. It is for developers who own services in production and want an agent to investigate failures
while they approve every change.

Website and user docs: [opsconsole.org](https://opsconsole.org), built from `site/`. Stack, modules and
diagrams: [docs/architecture.md](docs/architecture.md), with the drawings in [docs/diagrams](docs/diagrams). Decisions:
[docs/adr](docs/adr). Terms: [GLOSSARY.md](GLOSSARY.md). Plans: [docs/roadmap.md](docs/roadmap.md). The screens come from
[design/ops-console.html](design/ops-console.html) and the layout from
[design/ops-console-sidebar.html](design/ops-console-sidebar.html); open them in a browser.

## What you can do with it

- **Monitor.** Read the failing requests of each Service from Datadog, an OpenTelemetry Log folder, CloudWatch logs,
  Loki or New Relic, one tab per source. Each kind of failure becomes an Alert with a severity and a Route. Verify an
  Alert in a scratch copy of your code, review the Report, and confirm it to start a Fix that ends in a pull request.
- **Sessions and Pull requests.** Start Sessions with the agent in your Repos, each in its own git worktree. The
  Sessions page shows which need you. The Pull requests page lists pull requests across your Git hosts, with checks, threads, a conflict
  check and merge checks. Review with agent, Check replies and Address comments each open a Session on a pull request.
- **Browser panel and Terminals.** A Session has a Chrome page you and the agent both drive, with Chrome's DevTools,
  element pick and Local servers, and a Terminals dock for shells and long-running processes.
- **Dev tools.** Ask a question in plain words and have the agent query your databases, scoped to the Connections you
  choose, with Results and a Comparison.
- **Playbooks and Skills.** Write the rules and steps the agent follows for each Trigger, copy and edit the built-in
  ones, and attach Skills: built-in packs, your own, or a Repo's.
- **Integrations, Connections and MCP Servers.** Sixteen Connectors sign in once (Datadog, Jira, GitHub, GitLab,
  Bitbucket, Slack, Sentry, Shopify, slashdocs, Google Docs, Sheets and Drive, and the four log sources besides
  Datadog). Connections are the databases the agent may use, each with an Environment and an Access Level. Scheduled
  health checks say when any of them breaks.
- **Anonymous Sessions.** A Session with no Repo can also add Connections, MCP Servers and Connectors from what you type,
  after you approve each one, and asks for a password in a masked field the agent never sees. Accounts & Usage shows
  whether Full Disk Access, Start at login and the Run sandbox work.
- **Agent runs.** See each run's health, why it was slow or ended, where its time went and every call it made.
- **Accounts & Usage.** Add several Claude accounts, see each one's tokens and cost, and let Auto-switch or Smart usage
  move work between them. CLIProxy can sign the agent in instead.

## How it keeps the agent safe

- **Run sandbox.** Every run's shell commands run in the macOS sandbox. It is open to the network and to writes, as your
  own terminal is, and closed to the login Keychain folder, the installed app and git control files. It has no switch,
  and a run fails when the sandbox is unavailable. See [ADR 0006](docs/adr/0006-agent-runs-sandboxed-by-the-os.md).
- **Approvals.** The Access mode decides which edits and commands ask you first. A write to a PROD Connection asks in
  every mode.
- **PROD is read-only** for the agent unless you set write access on that Connection and approve the action. A command
  that writes to prod is yours to run.
- **It never merges.** Every run denies the merge commands and tools. The console, not the agent, pushes branches and
  posts replies. Merge is your button.
- **Local only.** The server listens on 127.0.0.1 with a session token, and secrets stay in the macOS Keychain. Nothing
  goes to a server the project runs.

## Install

On macOS 13.5 or later, on Apple silicon or Intel, with no sudo:

```
curl -fsSL https://raw.githubusercontent.com/narrowananth/ops-console/main/install.sh | sh
ops-console start
ops-console open
```

`OPS_CONSOLE_VERSION=<version>` installs a given release instead of the latest.

With Homebrew instead:

```
brew tap narrowananth/ops-console https://github.com/narrowananth/ops-console
brew trust narrowananth/ops-console
brew install ops-console
ops-console start
ops-console open
```

Current Homebrew refuses a formula from a tap you have not trusted. If `brew trust` is not found, your Homebrew does not
ask for it: skip that line.

Homebrew installs the `ops-console` command. The first command you run installs the app into `~/.ops-console`, and
`brew upgrade` brings the app up to the formula's version on the next command. `ops-console update` still installs the
newest release. `brew uninstall` removes only the command: run `ops-console uninstall` first to remove the app.

launchd starts the console at login and again if it stops. macOS lists it as Ops Console under System Settings ›
General › Login Items & Extensions › App Background Activity; keep it switched on there. Several browsers can use
it at once: `ops-console open "Google Chrome"` signs in a browser other than the default.

| Command | What |
|---|---|
| `ops-console start` | Start the daemon under launchd and keep it running |
| `ops-console stop` | Stop it until the next `start` |
| `ops-console status` | Running or stopped, with pid, version, port and health |
| `ops-console open [app]` | Open the console signed in, in the default browser or the browser app named |
| `ops-console logs` | Follow the daemon log |
| `ops-console update` | Install the latest release; restarts a running daemon |
| `ops-console uninstall` | Remove the install; data and logs stay |
| `ops-console --version` | Print the installed version |

## Layout

| Folder | What |
|---|---|
| `frontend/` | React 18 + Vite web UI |
| `backend/` | NestJS daemon: API, WebSocket, agent runtime, terminals, scheduled jobs; SQLite store |
| `cli/` | The `ops-console` command |
| `shared/` | Zod schemas and types both sides import: REST bodies, WebSocket events |
| `install.sh` | The installer |
| `Formula/` | The Homebrew formula, which the release workflow commits |
| `scripts/` | `pnpm dev:open`, `pnpm package`, the Homebrew formula and the DevTools build |
| `site/` | The opsconsole.org docs site, built by `pnpm site` into `site/dist` |
| `design/` | Claude Design export |
| `docs/` | Architecture, ADRs, specs, roadmap |
| `GLOSSARY.md` | Domain terms |

## Develop

Needs Node 24 and pnpm (`mise install`).

```
pnpm install
pnpm dev               # backend on 127.0.0.1:4556, UI on http://127.0.0.1:4555
pnpm dev:open          # open the UI signed in to the dev backend
```

It runs beside the installed app, which keeps 4545. The dev backend keeps its data in `backend/.data` and its
Keychain items under the service `ops-console-dev`, so it never reads or moves the installed app's. The tab reads
Ops Console (dev). On macOS launchd runs it as `Ops Console (dev).app`, so macOS
asks for Full Disk Access under that name, not the terminal's. The console's Keychain items move to each new build
of the app, so it reads them without asking. Its log streams into the `pnpm dev` terminal, and Ctrl+C stops it.
`OPS_CONSOLE_DEV_INLINE=1 pnpm dev` runs it in the terminal instead; macOS then asks for each Keychain item.

The Browser panel's Inspect button opens Chrome's DevTools, which `pnpm devtools-frontend` builds from the revision pinned
in `scripts/devtools-frontend.json` into `frontend/public/devtools-frontend`: a 3.4 GB download of build tools and 8 to 19
minutes the first time, then nothing until the pin changes. `pnpm package` and CI run it themselves; without it Inspect
opens an empty window in dev.

## Check

```
pnpm check             # lint, typecheck and tests in every package
pnpm db:generate       # write a migration after changing backend/src/db/schema.ts
pnpm package           # build out/ops-console-darwin-<arch>.tar.gz on this Mac
```

To try the install flow from your build (it replaces the installed app, and `pnpm dev` can keep running):

```
pnpm build && pnpm package
(cd out && shasum -a 256 ops-console-darwin-*.tar.gz > checksums.txt)
OPS_CONSOLE_RELEASE_URL="file://$PWD/out" sh install.sh
ops-console stop && ops-console start
```

Pushing a `v*` tag builds both tarballs on macOS runners, installs and runs each, then attaches them
to the GitHub Release.

Google Docs, Sheets and Drive sign in with a Google OAuth client the build ships. The release reads it from the repo
secrets `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`; `pnpm dev` reads `OPS_CONSOLE_GOOGLE_CLIENT_ID` and
`OPS_CONSOLE_GOOGLE_CLIENT_SECRET`. A build with neither cannot connect them.

## Making a change

1. `/spec <what you want>` in Claude Code writes `docs/specs/<slug>.md`.
2. `/ship <slug>` in a fresh session builds it, verifies it on the running app and opens a PR.
3. Review and merge the PR yourself.
