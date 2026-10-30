# frontend

React 18 + TypeScript + Vite web UI. The installed daemon serves the built UI on
`127.0.0.1:4545`; in development Vite serves it on `127.0.0.1:4545` and proxies `/api` and `/ws` to
the backend on 4546. Stack and layout in [../docs/architecture.md](../docs/architecture.md); screens
in [../design/ops-console.html](../design/ops-console.html).

```
src/
├── app/              # app gate, layout shell (top bar, views, settings drawer), UI store
├── features/         # monitor, workspace, devtools, settings: one folder per spec as it lands
├── components/ui/    # shadcn/ui-style components
├── lib/              # api client, session token, queries
└── styles/           # theme tokens ported from the design
e2e/                  # Playwright against the built daemon
```

`pnpm test` builds the daemon and UI, starts the daemon on a temporary data folder and runs
Playwright. Run `pnpm exec playwright install chromium` once.
