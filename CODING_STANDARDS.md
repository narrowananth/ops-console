# Coding standards

Read at review. Setup and commands live in [README.md](README.md).

## Tests

Tautological tests considered harmful.

A test asserts an outcome the operator, a caller or a store observes, and fails only when that
outcome changes. Flag change-detector tests in the diff: reading a config value back instead of
driving the component that reads it, snapshotting markup no one reviews, matching exact SQL text or
migration names, asserting a fake's call order.

Flag a test bent to pass instead of code fixed: assertion loosened, `.skip` or `.only` added, the
unit under test mocked.

Tests run real code against real stores. Backend tests use Postgres in Testcontainers. A fake
stands in only for what lives outside the process: Claude, Datadog, GitHub, Slack, an MCP server,
the shell.

Tooling: Vitest in both packages, Testing Library for React components, Playwright for browser
flows, `@nestjs/testing` with Supertest for HTTP.

Before approving a new test, grep the behaviour it drives. A test already pinning the same outcome
gets extended; no second test elsewhere.

A bug fix adds a test only where no existing test fails on the bug.

## Comments

Keep comments short. Delete any claim from comments that is derivable from the code. A comment
states the current reason; history ("used to", "replaced") goes in the commit message.

## TypeScript

`strict` on in every package. No `any`; `unknown` at a boundary, narrowed once. No non-null `!`
except where a comment states the fact the compiler can't see.

A changed exported type in `shared/` is not done until `pnpm check` passes in both packages.

## Invented requirements

Code guarding a requirement no spec or ADR states is a finding. Ask what the operator sees without
it; if nothing, delete it.

- Lock, mutex or `SELECT … FOR UPDATE` keeping loosely related rows in step.
- Re-check mid-request that narrows a race window and leaves it open.
- Retry, fallback or cache invalidation where the next scan or a reload already recovers.
- Client-side dedup of WebSocket events the server already sends once.

A spec's Not required section records guarantees given up on purpose. A guard the user approved
names its reason in the commit message.

## Boundaries

Parse an outside value once, where it enters: request body, WebSocket message, CLI output (`claude
mcp list`, `pup`, `gh`), MCP tool result, env, row read. Validate it there with a Zod schema into a
typed value and pass that inward. Past the boundary, trust the type: flag a re-check of what the
type already guarantees.

Catch an exception only where the code recovers or adds context; let the rest propagate. Flag a
catch that logs and rethrows, or wraps without adding anything.

## Agent and shell

Spawn processes with an argument array (`execFile`, `node-pty` args), never a shell string built
from input. Every agent action that leaves the process (DB write, shell command, Slack, GitHub)
writes an Action Log row before it runs.

Secrets never reach the database, logs, WebSocket payloads or the browser. Read them from the
Keychain adapter at the moment of use.

## API responses

REST returns `{ data }` or `{ data, page }`, or nothing for 204. Errors return
`{ error: { code, message } }`. `message` is specific and safe to show: no secret, no customer
data. The client branches on `code`, never `message`.

## Frontend

Server state through TanStack Query; UI-only state in Zustand. No fetch in components outside a
query or mutation hook. Components come from `frontend/src/components/ui` (shadcn/ui); colours and
spacing from the theme tokens ported from the design, never hard-coded.

Every panel has loading, empty and error states. A PROD connection always shows its PROD tag.

## Prose

Prose written into this repo goes through the `humanizer` skill, including ADRs, specs,
`GLOSSARY.md` and `README.md`. Titles count as prose. Code blocks, identifiers, commands and error
text stay exact.

## Naming

- Database tables: plural, snake case (`agent_sessions`, `verification_reports`).
- Domain types: singular, Pascal case (`Alert`, `Connection`).
- REST routes: plural (`/connections`, `/connections/:id`).
- Files: kebab case (`mcp-status-bar.tsx`, `monitor.service.ts`).
- WebSocket events: `<area>.<past-tense verb>` (`session.output`, `alert.verified`).
