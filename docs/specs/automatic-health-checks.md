# Automatic health checks

**Status:** ready
**Design:** Connections and Integrations in `design/ops-console.html`. The check strip, the problem banner and the history stripe depart from it: the design has none of them.

## Problem

A Connection that loses its password, a Connector that signs out or an MCP server that stops starting shows as failing only when the operator opens its page and a check happens to run. The agent then fails halfway through a run on it. The operator wants the console to check on a schedule and say when something breaks or comes back.

## Behavior

1. Connections and Integrations each check themselves on a schedule: every 5 minutes, 15 minutes, 30 minutes, 1 hour, 6 hours, or off. Defaults are 15 minutes for Connections and 30 minutes for Integrations. The daemon runs the checks, so they happen with no browser open. The interval is the setting `health_checks`, and each page keeps its own.
2. A run of Connections checks every Connection whose Access Level is not `none`, one at a time. A run of Integrations checks every Connector that is not `off`, and every registered, enabled MCP server, one at a time. Checks are the ones the pages already use, and send no write.
3. The first run starts about 20 seconds after the daemon starts, then each area runs when its interval has passed since its last run. Turning an interval off stops that area. Only one run of an area goes at a time.
4. Check now starts a run of the area at once and answers at once. The page shows "Checking… N of M done" while it goes.
5. Every check is kept: its status, detail, latency and time. Two checks of the same item with the same answer within 30 seconds are kept once. The history stripe shows the last 24 checks, oldest first. The console keeps 90 days of checks, pruned like the rest of the run history.
6. Failing means status `fail` or `auth`. An item that is failing shows "Failing 14 min" from the first check of its current run of failures, and its detail. An item that answers again after failing reads Recovered for an hour, with when it was down.
7. A problem banner on each page names what is failing in that area, its detail and since when. With more than one, it names the first two and the count. When everything in the area answered at its last check, the page shows "Everything answers" instead.
8. The sidebar shows a red count on Connections and on Integrations while that area has failing items.
9. When a check turns a working item into a failing one, and when it turns a failing one back, the daemon sends `health.changed` once. An item that stays down sends nothing more until it recovers. An item that fails at its first check counts as a break. A burst of events for one answer is one check.
10. With "Alert when a connection or integration breaks" on in Notifications, the page shows a desktop alert for each `health.changed`, under the same rules as run alerts: only when the console is open in a tab that is not in front and the browser allowed alerts.
11. An MCP server that a Connection registers for itself is not an Integration: its checks count under the Connection.

## Settled

- **Failing**: `fail` and `auth` both. A signed-out Connector needs the operator, so it counts.
- **Where it runs**: the daemon, not the page.
- **One check path**: a check is anything that sends `connection.checked`, so a manual Retry or a sign-in lands in the history as well.

## Not required

- **Exact schedule**: a run starts within 30 seconds of its interval.
- **History past 24 checks on the page**: older checks stay in the database for 90 days and are not shown.

## Safety

No change. The checks are the reads the pages already make: a Connection's check starts its read-only server and runs one read, a Connector's reads its CLI, an MCP server's reads its tools. Nothing writes, and PROD Connections stay read-only.

## Database

```sql
CREATE TABLE health_checks (
  id text PRIMARY KEY NOT NULL,
  target text NOT NULL,      -- connection, connector or mcp_server
  target_id text NOT NULL,
  status text NOT NULL,      -- ok, fail or auth
  detail text,
  latency_ms integer,
  checked_at text NOT NULL
);
CREATE INDEX health_checks_target_idx ON health_checks (target, target_id, checked_at);
CREATE INDEX health_checks_checked_idx ON health_checks (checked_at);
```

## API

### `GET /health-watch`

Returns `{ data: HealthOverview }`: `areas.connections` and `areas.integrations` each with `interval`, `last_checked_at`, `next_check_at` (null when off) and `checking` (`{ done, total }` while a run goes, else null), and `items`, each with `area`, `target`, `id`, `name`, `kind`, `is_prod`, `status`, `detail`, `latency_ms`, `last_checked_at`, `failing_since`, `recovered_at` and `history` (up to 24 `{ status, at }`).

### `POST /health-watch/:area/checks`

`area` is `connections` or `integrations`. Starts a run and answers 202 with the overview. Unknown area: 404 `not_found`.

### `PATCH /settings`

Key `health_checks`: `{ "connections": "<interval>", "integrations": "<interval>" }`, interval one of `5m`, `15m`, `30m`, `1h`, `6h`, `off`. Anything else: 400 `validation_failed`.

### WebSocket `health.changed`

Server to client when an item breaks or recovers: `area`, `target`, `id`, `name`, `status`, `detail`, `since` (when it began failing, null on recovery) and `recovered`.

## UI

The check strip and problem banner at the top of Connections and Integrations, the history stripe, the failing and Recovered pills on each row, the red sidebar count, and the third alert switch in Notifications on Accounts & Usage.

## Rejected

- **Checking from the page**: nothing would run with the tab closed.
- **One interval for both pages**: Connections start a database server per check, Integrations read CLIs; they cost differently.

## Glossary

- **Health check**: the console's own scheduled check of a Connection, Connector or MCP server, with its history.

## Seams

- **Daemon** (`backend/test/health-watch.test.ts`): 1 to 6, 9, 11.
- **Browser** (`frontend/e2e/health-watch.spec.ts`): 4 to 8, 10.

## Out of scope

- Alerts outside the browser, such as email or a chat message.
