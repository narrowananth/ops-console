# Account switch and usage

**Status:** ready
**Design:** Agents & accounts (now Accounts & Usage) in `design/ops-console.html` (the accounts list). The Enable switch on each row and the Usage tab depart from it: the design has neither.

## Problem

The operator has several Claude accounts and cannot tell an agent to leave one alone, for instance an account kept for other work, or one near its weekly limit that must not be picked up by Smart usage. Nor can they see which account's credit the agents spend: how much each account used, which runs and subagents used it, and how that moves from day to day.

## Behavior

Enable and Disable

1. Each Claude account has an Enable switch. A new account is enabled. A disabled account stays signed in and keeps its usage bars; the console never starts or moves a run onto it.
2. Use on a disabled account is refused with `invalid_state`, and the row hides Use's effect by dimming it. Smart pick, Smart rank, Auto-switch and the retry after a rate-limit rejection skip a disabled account. A disabled account's smart note reads "disabled, skipped".
3. Disabling the active account hands the active role to the account Auto-switch would pick, with switch reason `disabled`, or to no account when none is enabled and signed in. The page asks first and names the account the runs move to. A run going on the account finishes on it. A Session whose transcript is on it moves to the new account on its next run, as for any switch.
4. Disabling the last enabled account is allowed. A new run then fails with `invalid_state`: "every Claude account is disabled; enable one in Accounts & Usage".
5. Enabling an account never moves a run. While no account is active, enabling a signed-in account makes it active, so runs can start again; otherwise Smart usage or the operator's Use picks it later.
6. A signed-out account's switch is dimmed, with "Sign in first" on hover. With CLIProxy on, every switch is dimmed with "CLIProxy picks the account", and the daemon refuses a change with `invalid_state`.
7. The switch survives a reload and a restart, and a change shows in every open tab through `account.updated`.

Usage dashboard

8. Accounts & Usage has two tabs, Accounts and Usage. The URL carries `?tab=usage`, `&account=<id>` for one account and `&range=today|7d|30d|90d`. The default is all accounts, 7 days.
9. Every run records the account it ended on, with its tokens, cost and subagents. A run that moved accounts after a rate-limit rejection counts for the second one. With CLIProxy on, a run counts for no account. Runs kept before this change have no account and count as "Not attributed", so the All accounts total matches the Running tray's day total. A removed account's runs stay and count as "Removed account".
10. The console keeps 90 days of run steps, subagents and usage, and no more. Rows past 90 days are deleted oldest first, 250 rows at a time, each batch in its own short transaction with a pause between batches, so no request waits behind a bulk delete. Pruning runs once after the daemon starts and then once a day, never when a run starts. A run's detail on the Agent runs page keeps its steps for the same 90 days.
11. All accounts shows: tokens (input, output, cache read, cache write), estimated cost, runs and subagents; cost per day stacked by account; a By account table with a share bar, where each row has tokens, cost, runs and subagents; By kind (Repo, Agent Review, Monitor Verify, Monitor Fix, Dev tools, Playbook and the rest); By subagent type, with "Main agents only" as its own row; and Top spenders, the 25 costliest runs, each opening to its main agent and subagents.
12. One account shows the same, filtered to that account: its 5-hour and weekly bars, its Enabled or Disabled state, a trend stacked by kind, By kind, By subagent type and its runs.
13. Cost is the estimate priced from raw token counts, the same way as a run's cost on the Agent runs page. It is labelled "at API prices, not billed". Totals and rows add up: the days, the accounts and the kinds each sum to the totals.
14. Every subagent a run starts is kept when it starts: its type, what it was asked, the subagent that started it, its status (`working`, `done`, `failed`, `stopped`), and when it started and finished. A subagent that ends with the run, because the run finished, failed or was stopped, or because the daemon restarted, gets that end. A subagent that used no tokens still counts. Subagents of runs kept before this change are known from their token lines, or not at all; they count under "Type not kept". There is no backfill.
15. Days are the machine's local days. A range with no runs says "No agent runs in the last 7 days" with the other ranges as links. A failed read shows the error with Try again. While reading, the tab shows skeleton lines.
16. With every account disabled, the Accounts and Usage tabs show "Every Claude account is disabled" with a link to Accounts.
17. With CLIProxy on, the Usage tab lists the runs this console recorded and says CLIProxy picks the account for new runs.

## Settled

- **Disabled**: skipped by Use, Smart pick, Auto-switch and failover. It stays signed in. A running run is not stopped.
- **Attribution**: the account a run ended on; `null` for CLIProxy and for runs before this change. No backfill from the Session's account, since a Session may have moved.
- **Dollars**: an estimate priced from raw tokens, never the SDK's reported figure, so the dashboard and the Agent runs page agree.
- **Retention**: 90 days of steps, subagents and usage, pruned in batches of 250 rows. Measured on 720,000 step rows: one delete of 360,000 rows held the daemon for 1.2 s; batches of 1,000 held it up to 150 ms; batches of 250 about 20 ms.
- **Quota history**: not kept. The bars show the current 5-hour and weekly percent only.
- **Days**: local to the daemon's machine, grouped by the day the run ended.
- **Switch reason**: `disabled` joins `manual`, `auto`, `smart`, `rate_limited` and `sign_in_failed`.

## Not required

- **Quota percent over time**: the Usage tab shows current percent only; a history needs its own sampler.
- **Exact split of a run across two accounts**: a run that moved accounts counts whole for the second one.
- **Subagents of old runs**: runs kept before this change show "Type not kept", with no status or duration.

## Safety

No change. The page reads the console's own saved usage and changes one flag on an account. The agent's reach is the same.

## Database

```sql
CREATE TABLE run_agents (
  id text PRIMARY KEY NOT NULL,
  session_id text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  run_started_at text NOT NULL, -- ties the subagent to its run
  task_id text NOT NULL, -- the id its steps and usage lines carry as agent_id
  parent_id text, -- the subagent that started it; null when the main agent did
  type text,
  description text NOT NULL, -- redacted, 200 characters
  status text NOT NULL, -- working, done, failed or stopped
  started_at text NOT NULL,
  finished_at text,
  UNIQUE (session_id, run_started_at, task_id)
);
CREATE INDEX run_agents_started_idx ON run_agents (started_at);
CREATE INDEX run_steps_started_idx ON run_steps (started_at); -- retention reads the oldest rows by this
ALTER TABLE claude_accounts ADD enabled integer NOT NULL DEFAULT 1;
ALTER TABLE run_usage ADD account_id text; -- the account the run ended on; null for CLIProxy and runs before this column
CREATE INDEX run_usage_account_idx ON run_usage (account_id, finished_at);
```

Existing accounts are enabled. Existing `run_usage` rows keep a null `account_id`. `run_usage.breakdown` lines gain optional `agent_type` and `agent_description`.

## API

### Common

`Range` is `today`, `7d`, `30d` or `90d`.

| Status | Error code      | When                                                            |
| ------ | --------------- | --------------------------------------------------------------- |
| 400    | `validation_failed` | `range` is not one of the four, or the body is not `{ "enabled": boolean }` |
| 404    | `not_found`     | no such Claude account                                          |
| 409    | `invalid_state` | CLIProxy is on; or Use on a disabled account                    |

### `PATCH /agent-accounts/:id`

Body `{ "enabled": boolean }`. Returns `{ data: ClaudeAccount }`. `ClaudeAccount` gains `enabled`. Disabling the active account switches as in Behavior 3.

### `POST /agent-accounts/:id/activate`

Refused with `invalid_state` while the account is disabled.

### `GET /agent-accounts/usage?range=<Range>&account=<id>`

`account` is an account id, or `none` for runs with no account; absent means every account. Returns:

```json
{ "data": {
  "range": "7d", "account_id": null, "from": "2026-10-31", "to": "2026-11-06",
  "totals": { "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 }, "cost_usd": 0, "runs": 0, "subagents": 0 },
  "days": [ { "date": "2026-11-06", "cost_usd": 0, "tokens": 0, "runs": 0,
              "by_account": [ { "account_id": "a1|null", "cost_usd": 0 } ],
              "by_kind": [ { "kind": "repo", "cost_usd": 0 } ] } ],
  "accounts": [ { "account_id": "a1|null", "label": "ops@example.com", "removed": false, "enabled": true,
                  "tokens": 0, "cost_usd": 0, "runs": 0, "subagents": 0 } ],
  "kinds": [ { "kind": "repo", "tokens": 0, "cost_usd": 0, "runs": 0 } ],
  "subagent_types": [ { "type": "Explore|null", "main": false, "tokens": 0, "cost_usd": 0, "agents": 0,
                        "failed": 0, "avg_ms": 0 } ],
  "runs": [ { "session_id": "s1", "title": "…", "kind": "repo", "account_id": "a1|null", "finished_at": "…",
              "tokens": 0, "cost_usd": 0, "subagents": 0,
              "agents": [ { "agent_id": "null|t1", "parent_id": "null|t1", "type": "Explore|null", "description": "…",
                            "status": "done|failed|stopped|working|null", "started_at": "…", "finished_at": "…",
                            "tokens": 0, "cost_usd": 0 } ] } ]
} }
```

`runs` holds the 25 costliest. `label` is the account's email, its label when it has none, "Not attributed" for `null`, and "Removed account" for an id no account has.

### WebSocket `account.updated`

Server to client, unchanged; carries the account with `enabled`. Fires when the switch changes.

## UI

Accounts & Usage gets the tabs Accounts and Usage.

- **Accounts**: each row has an Enabled or Disabled label and a switch under its buttons. A disabled row dims its bars, shows a DISABLED pill, and its note reads "Disabled: skipped by Use, Smart pick and failover. Runs going on it finish." Disabling the active account asks first, naming the account the runs move to. A signed-out account's switch and CLIProxy's switches are dimmed with the reason.
- **Usage**: an account picker (All accounts, one chip per account, each with its colour), a range control, four figures, the daily trend, By account, By kind, By subagent type and Top spenders. One account swaps By account for its bars and Enabled state. States: loading skeleton, empty range, read error, every account disabled, CLIProxy note.

## Rejected

- **Quota percent history**: needs a sampler; the dollars and tokens answer where the credit went.
- **Backfilling `account_id` from the Session**: a Session may have moved, so old runs would be wrong rather than missing.
- **A page of its own for Usage**: the account list and its usage belong together; tabs keep one place.

## Glossary

- **Disabled account**: a Claude account the console never starts or moves a run onto; it stays signed in.
- **Account usage**: the tokens, estimated cost, runs and subagents the console recorded for each Claude account, by day, run kind and subagent type.
- **Not attributed**: runs that have no account: before the console kept one, or through CLIProxy.

## Seams

- **Daemon** (`backend/test/agent-accounts.test.ts`, `backend/test/account-usage.test.ts`, `backend/test/retention.test.ts`): 1 to 7, 9 to 14.
- **Unit** (`backend/test/smart-rank.test.ts`): 2.
- **Browser** (`frontend/e2e/accounts.spec.ts`, `frontend/e2e/account-usage.spec.ts`): 1 to 3, 6, 8, 11, 12, 15 to 17.

## Out of scope

- Quota percent over time, and a per-account spend limit, go to their own spec.
