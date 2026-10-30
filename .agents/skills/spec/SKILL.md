---
name: spec
description: Settle one change (feature, bug, or perf) into a local Markdown spec under docs/specs/, ready for /ship.
disable-model-invocation: true
---

# Spec

`/spec <description>`. One change per run. No ticket: the spec file is the record. It lands as
`docs/specs/<slug>.md`, where `/ship <slug>` picks it up in a fresh session. Apart from that one
file the repo stays untouched: every settled term and decision goes in the spec, and `/ship` writes
it to the docs.

A step that names a skill (`grilling`, `domain-modeling`, `codebase-design`, `diagnosing-bugs`,
`diagram-design`) runs it by calling the Skill tool with that name.

## Steps

1. **Slug.** No description in the ask: ask for one and wait. Derive a kebab-case slug of three to
   five words naming the change (`mcp-status-bar`, `verify-failing-route`). A file of that name
   already in `docs/specs/`: this run revises it, and keeps its headings stable. State the slug
   and the screen in `design/ops-console.html` the change belongs to, if any. Done when both are
   stated and the user accepts the slug.
2. **Shape.**
   - Feature: `grilling` and `domain-modeling`, with the spec draft as the record; `codebase-design`
     on design branches. Read the matching screen in `design/ops-console.html` first; where the
     change departs from it, say so and settle it. Done when the frontier is empty and the user
     confirms the design.
   - Bug or perf: `diagnosing-bugs`. Done when a test or measurement goes red on the bug, or shows
     the baseline number for perf.
3. **Spec.** Synthesise; the interview is over. Propose the seams the tests drive: prefer existing
   ones, pick the highest, keep the count low. Once the user confirms them, write the template below
   to `docs/specs/<slug>.md`. Done when the file holds confirmed seams and every term and decision
   the grill settled.
4. **Hand off.** Stop and tell the user to run `/ship <slug>` in a fresh session. Do not commit:
   `/ship` commits the spec with the change.

## Spec template

Glossary terms throughout. No file paths or code beyond the Database schema, the API shapes and
the WebSocket events; a state machine may go in, trimmed to the decision, as may a diagram from
`diagram-design` where a flow reads better drawn than listed. Identifiers go in backticks. Drop any
section the change leaves alone.

```markdown
# <Title>

**Status:** draft | ready | shipped
**Design:** <screen or panel in design/ops-console.html, or "none">

## Problem

The problem from the operator's side: the person watching the console, reviewing a fix, or
running an agent session.

## Behavior

1. One testable invariant per item, from the operator's side: the happy path, then each state and
   what moves it to the next. Cover each case that applies: empty or missing data, an MCP server
   that is down or needs auth, a Datadog or GitHub rate limit, the agent failing mid-run, two
   sessions at once, a PROD connection, a reload mid-stream, and what must not regress. A case the
   change lets go belongs under Not required.

## Settled

- **Term**: decision, one line each. Statuses, concurrency, migration order.

## Not required

- **Guarantee** the change gives up: what the operator sees instead (stale for a minute, a retry on
  the next scan). Review flags code that keeps it.

## Safety

What the agent may and may not do in this change: read or write, which connections, which shell
commands, what needs the operator's approval. Write "no change" when the agent's reach is the
same as before.

## Database

SQLite DDL in one `sql` block: `CREATE TABLE` or `ALTER TABLE` per table touched, with keys,
constraints and indexes, and a `--` comment on any column whose meaning the name leaves open.
Below it, the migration of existing rows.

## API

### Common

What two or more endpoints share, stated once: params, request and response bodies as named JSON
blocks with a line per field, and the errors table.

| Status | Error code | When |
| ------ | ---------- | ---- |

### `METHOD /path`

Only what this endpoint adds or changes: its params, bodies and errors, naming a Common block
instead of repeating it.

### WebSocket `<event>`

Direction (server to client or client to server), payload as JSON, and when it fires.

## UI

Screens and panels touched, each with its states: loading, empty, error, PROD. Name the design
screen it follows and any departure from it.

## Rejected

- **Option**: why it lost.

## Glossary

- **Term**: definition, for each term added to or changed in GLOSSARY.md.

## ADR

- **Title**: decision and the trade-off, for each one hard to reverse, surprising and a real trade-off.

## Seams

- **Seam** (unit, backend + SQLite, frontend component, browser): the Behavior numbers it pins.
  Every number appears under some seam.

## Out of scope

- What this change leaves for later, and where it goes.
```
