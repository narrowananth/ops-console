# ops-console

A local console on top of Claude Code. It shows which MCP servers are connected, how each service
is doing in Datadog, the databases the agent may use, open PRs and Claude sessions. When a route
fails, the agent reproduces it locally and writes a report; the operator reviews it, and only then
does the agent fix the code and open a PR.

The screens come from [design/ops-console.html](design/ops-console.html) (open it in a browser).
Stack and modules: [docs/architecture.md](docs/architecture.md). Terms: [GLOSSARY.md](GLOSSARY.md).

## Install

On macOS (arm64 or x64), with no sudo:

```
curl -fsSL https://raw.githubusercontent.com/narrowananth/ops-console/main/install.sh | sh
ops-console start
ops-console open
```

`OPS_CONSOLE_VERSION=<version>` installs a given release instead of the latest.

| Command | What |
|---|---|
| `ops-console start` | Start the daemon under launchd and keep it running |
| `ops-console stop` | Stop it until the next `start` |
| `ops-console status` | Running or stopped, with pid, version, port and health |
| `ops-console open` | Open the console in the browser, signed in |
| `ops-console logs` | Follow the daemon log |
| `ops-console update` | Install the latest release; restarts a running daemon |
| `ops-console uninstall` | Remove the install; data and logs stay |
| `ops-console --version` | Print the installed version |

## Layout

| Folder | What |
|---|---|
| `frontend/` | React 18 + Vite web UI |
| `backend/` | NestJS daemon: API, WebSocket, agent runtime, jobs |
| `cli/` | The `ops-console` command |
| `shared/` | Types both sides import |
| `install.sh` | The installer |
| `design/` | Claude Design export |
| `docs/` | Architecture, ADRs, specs |

## Develop

Needs Node 24 and pnpm (`mise install`). No Docker.

```
pnpm install
pnpm dev               # backend on 127.0.0.1:4546, UI on http://127.0.0.1:4545
pnpm dev:open          # open the UI signed in to the dev backend
```

The dev backend keeps its data in `backend/.data`.

## Check

```
pnpm check             # lint, typecheck and tests in every package
pnpm db:generate       # write a migration after changing backend/src/db/schema.ts
pnpm package           # build out/ops-console-darwin-<arch>.tar.gz on this Mac
```

Pushing a `v*` tag builds both tarballs on macOS runners, installs and runs each, then attaches them
to the GitHub Release.

## Making a change

1. `/spec <what you want>` in Claude Code writes `docs/specs/<slug>.md`.
2. `/ship <slug>` in a fresh session builds it, verifies it on the running app and opens a PR.
3. Review and merge the PR yourself.
