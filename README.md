# ops-console

A local console on top of Claude Code. It shows which MCP servers are connected, how each service
is doing in Datadog, the databases the agent may use, open PRs and Claude sessions. When a route
fails, the agent reproduces it locally and writes a report; the operator reviews it, and only then
does the agent fix the code and open a PR.

The screens come from [design/ops-console.html](design/ops-console.html) and the layout from
[design/ops-console-sidebar.html](design/ops-console-sidebar.html) (open them in a browser).
Stack and modules: [docs/architecture.md](docs/architecture.md). Terms: [GLOSSARY.md](GLOSSARY.md).

## Install

On macOS 13.5 or later, on Apple silicon or Intel, with no sudo:

```
curl -fsSL https://raw.githubusercontent.com/narrowananth/ops-console/main/install.sh | sh
ops-console start
ops-console open
```

`OPS_CONSOLE_VERSION=<version>` installs a given release instead of the latest.

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
| `scripts/` | `pnpm dev:open` and `pnpm package` |
| `design/` | Claude Design export |
| `docs/` | Architecture, ADRs, specs |
| `GLOSSARY.md` | Domain terms |

## Develop

Needs Node 24 and pnpm (`mise install`).

```
pnpm install
pnpm dev               # backend on 127.0.0.1:4546, UI on http://127.0.0.1:4545
pnpm dev:open          # open the UI signed in to the dev backend
```

The dev backend keeps its data in `backend/.data`. On macOS launchd runs it as `Ops Console (dev).app`, so macOS
asks for Full Disk Access under that name, not the terminal's. The console's Keychain items move to each new build
of the app, so it reads them without asking. Its log streams into the `pnpm dev` terminal, and Ctrl+C stops it.
`OPS_CONSOLE_DEV_INLINE=1 pnpm dev` runs it in the terminal instead; macOS then asks for each Keychain item.

## Check

```
pnpm check             # lint, typecheck and tests in every package
pnpm db:generate       # write a migration after changing backend/src/db/schema.ts
pnpm package           # build out/ops-console-darwin-<arch>.tar.gz on this Mac
```

To try the install flow from your build, with `pnpm dev` still holding 4545:

```
pnpm build && pnpm package
(cd out && shasum -a 256 ops-console-darwin-*.tar.gz > checksums.txt)
OPS_CONSOLE_RELEASE_URL="file://$PWD/out" sh install.sh
OPS_CONSOLE_PORT=4547 ops-console start
```

Pushing a `v*` tag builds both tarballs on macOS runners, installs and runs each, then attaches them
to the GitHub Release.

## Making a change

1. `/spec <what you want>` in Claude Code writes `docs/specs/<slug>.md`.
2. `/ship <slug>` in a fresh session builds it, verifies it on the running app and opens a PR.
3. Review and merge the PR yourself.
