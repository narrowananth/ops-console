# frontend

React 18 + TypeScript + Vite web UI. The installed daemon serves the built UI on
`127.0.0.1:4545`; in development Vite serves it on `127.0.0.1:4555` and proxies `/api`, `/ws` and `/terminals` to
the backend on 4556. Stack and layout in [../docs/architecture.md](../docs/architecture.md); screens
in [../design/ops-console.html](../design/ops-console.html).

```
src/
├── app/              # app gate, sidebar shell, routes, updates, running tasks, UI store
├── monitor/ workspace/ devtools/ integrations/ repos/ setup/ playbooks/ agents/   # one folder per page
├── components/ui/    # shared controls: Tip, fold, side panel, pathway, attachment viewer
├── lib/              # api client, session token, queries, live events, Remembered view, chime
└── styles/           # theme tokens ported from the design
e2e/                  # Playwright against the built daemon
```

`pnpm test` builds the daemon and UI, starts the daemon on a temporary data folder and runs
Playwright. Run `pnpm exec playwright install chromium` once.
