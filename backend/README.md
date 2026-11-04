# backend

The daemon: NestJS on Node 24. Installed, it listens on `127.0.0.1:4545` and serves the built UI,
`/api` and `/ws`. In development (`pnpm dev`) it listens on `127.0.0.1:4556` behind Vite and keeps its
data in `.data/`. Modules and data flow in [../docs/architecture.md](../docs/architecture.md).

```
src/
├── main.ts             # reads env, starts the daemon, stops it on SIGTERM
├── daemon.ts           # start-up order: lock, migrate, recover, listen, schedule
├── app.module.ts
├── common/             # logger, errors, paging, session token, recovery, /ws hub, data folder
├── db/                 # schema, migrations runner, Store.write
├── auth/               # session token guard
├── settings/           # registry and /api/settings
├── scheduler/          # in-process jobs
├── keychain/           # login Keychain adapter, handover between app versions
├── claude-cli/         # claude mcp add/remove/list/get/login
├── mcp-client/         # tool calls on registered MCP servers
├── mcp/                # MCP Servers, Probe, the mcp-exec launcher
├── connectors/         # the Connectors: sign-in, MCP Server, checks
├── connections/        # Connections, Access Levels, checks
├── repos/              # Repos, local git reads
├── agent/              # Sessions, Agent SDK runs, hooks, transcripts
├── playbooks/          # Playbooks, Step blocks, built-ins, job steps
├── accounts/           # Claude accounts, usage, Auto-switch, Smart usage, CLIProxy
├── action-log/         # Action Log, Approvals, redaction
├── workspace/          # pull requests, Agent Reviews, Reply checks, Comment passes
├── monitor/            # Services, Scans, Alerts, Verification, Fix
├── devtools/           # devtools Sessions scoped to Connections
├── terminals/          # node-pty terminals, the Setup agent
└── updates/            # newest GitHub release, install, auto-update
drizzle/                # Drizzle Kit output, never edited once applied
test/                   # daemon on a temporary data folder; fakes for claude, MCP and Keychain
```

| Env | Default |
|---|---|
| `OPS_CONSOLE_DATA_DIR` | `~/Library/Application Support/ops-console` |
| `OPS_CONSOLE_PORT` | `4545` |
| `OPS_CONSOLE_APP_DIR` | folder of `main.js`; holds `drizzle/` and `public/` |
| `OPS_CONSOLE_KEYCHAIN_SERVICE` | Keychain service name; `ops-console` unless set (dev uses `ops-console-dev`) |
| `OPS_CONSOLE_LAUNCHER` | `bin/ops-console` of the install that `mcp-exec` and `mcp-setup` run through |

`pnpm build` bundles `dist/main.js` with esbuild. Classes inject with explicit `@Inject(...)`:
esbuild does not emit decorator metadata.
