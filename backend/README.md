# backend

NestJS on Node 24, listening on `127.0.0.1:4546`. Modules and data flow in
[../docs/architecture.md](../docs/architecture.md).

```
src/
├── main.ts
├── modules/
│   ├── mcp/            # claude mcp list, server status and actions
│   ├── monitor/        # services, routes, scans, alerts (pup)
│   ├── verification/   # agent verification runs, reports
│   ├── review/         # operator review, starts the fix session
│   ├── workspace/      # repos, sessions, branches, PRs (gh)
│   ├── agent/          # Claude Agent SDK runs and permission rules
│   ├── terminal/       # node-pty over websocket
│   ├── connections/    # connections, access levels, keychain secrets
│   ├── action-log/     # record of every outside action
│   └── auth/           # local session token
├── db/
│   ├── schema/         # Drizzle tables
│   └── migrations/     # Drizzle Kit output, never edited once applied
└── common/             # config, zod pipes, error filter
test/                   # Testcontainers Postgres suites
```
