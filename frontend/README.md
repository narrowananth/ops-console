# frontend

React 18 + TypeScript + Vite web UI, served on `localhost:4545`. Stack and layout in
[../docs/architecture.md](../docs/architecture.md); screens in
[../design/ops-console.html](../design/ops-console.html).

```
src/
├── app/              # router, providers, layout shell (top bar, nav, settings drawer)
├── features/
│   ├── monitor/      # services, routes, alerts, verification report, review
│   ├── workspace/    # sessions, composer, PR list and review
│   ├── devtools/     # connections, terminal
│   └── settings/     # MCP servers, repos, connectors, account
├── components/ui/    # shadcn/ui components
├── lib/              # api client, websocket client, query keys
└── styles/           # theme tokens ported from the design
```
