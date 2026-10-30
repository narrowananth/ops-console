# ops-console

A local console on top of Claude Code. It shows which MCP servers are connected, how each service
is doing in Datadog, the databases the agent may use, open PRs and Claude sessions. When a route
fails, the agent reproduces it locally and writes a report; the operator reviews it, and only then
does the agent fix the code and open a PR.

The screens come from [design/ops-console.html](design/ops-console.html) (open it in a browser).
Stack and modules: [docs/architecture.md](docs/architecture.md). Terms: [GLOSSARY.md](GLOSSARY.md).

## Layout

| Folder | What |
|---|---|
| `frontend/` | React 18 + Vite web UI |
| `backend/` | NestJS API, agent runtime, terminal, jobs |
| `shared/` | Types both sides import |
| `design/` | Claude Design export |
| `docs/` | Architecture, ADRs, specs |

## Run

Needs Docker, Node 24 and pnpm (`mise install`).

```
docker compose up -d   # Postgres on :55432, Redis on :56379
pnpm install
pnpm db:migrate
pnpm dev               # http://localhost:4545
```

## Check

```
pnpm check             # lint, typecheck and tests in every package
```

## Making a change

1. `/spec <what you want>` in Claude Code writes `docs/specs/<slug>.md`.
2. `/ship <slug>` in a fresh session builds it, verifies it on the running app and opens a PR.
3. Review and merge the PR yourself.
