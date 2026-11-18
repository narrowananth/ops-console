# Run from source

Ops Console is open source under the MIT License. You can run it from source beside an installed copy.

## Set up

It needs Node 24 and pnpm. `mise install` sets both up from the repo's `mise.toml`.

```
git clone https://github.com/narrowananth/ops-console.git
cd ops-console
pnpm install
pnpm dev               # backend on 127.0.0.1:4556, UI on http://127.0.0.1:4555
pnpm dev:open          # open the UI signed in to the dev backend
```

The dev build runs beside the installed app, which keeps port 4545. The dev backend keeps its data in `backend/.data` and its Keychain items under the service `ops-console-dev`, so it never reads or moves the installed app's. The browser tab reads Ops Console (dev). Its log streams into the `pnpm dev` terminal, and Ctrl+C stops it.

## Google sign-in in development

A release build ships a Google OAuth client. A build from source does not, so the Google Connectors say "Google sign-in is not set up in this build". To connect them while developing, create a Desktop app OAuth client in your own Google Cloud project, enable the Docs, Sheets and Drive APIs, and set:

```
export OPS_CONSOLE_GOOGLE_CLIENT_ID='<your client id>'
export OPS_CONSOLE_GOOGLE_CLIENT_SECRET='<your client secret>'
```

Then restart `pnpm dev`.

## Check

```
pnpm check             # lint, typecheck and tests in every package
pnpm db:generate       # write a migration after changing backend/src/db/schema.ts
pnpm package           # build out/ops-console-darwin-<arch>.tar.gz on this Mac
```

## Layout

| Folder | What |
| ------ | ---- |
| `frontend/` | React 18 and Vite web UI |
| `backend/` | NestJS daemon: API, WebSocket, agent runtime, terminals, scheduled jobs, SQLite store |
| `cli/` | The `ops-console` command |
| `shared/` | Zod schemas and types both sides import |
| `docs/` | Architecture, ADRs and specs |
| `site/` | This website |

The [architecture notes](https://github.com/narrowananth/ops-console/blob/main/docs/architecture.md) and the [decision records](https://github.com/narrowananth/ops-console/tree/main/docs/adr) explain how the parts fit. To make a change, write a spec with `/spec <what you want>` in Claude Code, then build it with `/ship <slug>` in a fresh session. You review and merge the pull request.

## Release

Pushing a `v*` tag builds both tarballs on macOS runners, installs and runs each, then attaches them to the GitHub release.
