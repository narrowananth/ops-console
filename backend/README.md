# backend

The daemon: NestJS on Node 24. Installed, it listens on `127.0.0.1:4545` and serves the built UI,
`/api` and `/ws`. In development (`pnpm dev`) it listens on `127.0.0.1:4546` behind Vite and keeps its
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
├── keychain/           # login Keychain adapter
├── claude-cli/         # claude mcp add/remove/list/get
└── mcp-client/         # tool calls on registered MCP servers
drizzle/                # Drizzle Kit output, never edited once applied
test/                   # daemon on a temporary data folder; fakes for claude, MCP and Keychain
```

| Env | Default |
|---|---|
| `OPS_CONSOLE_DATA_DIR` | `~/Library/Application Support/ops-console` |
| `OPS_CONSOLE_PORT` | `4545` |
| `OPS_CONSOLE_APP_DIR` | folder of `main.js`; holds `drizzle/` and `public/` |

`pnpm build` bundles `dist/main.js` with esbuild. Classes inject with explicit `@Inject(...)`:
esbuild does not emit decorator metadata.
