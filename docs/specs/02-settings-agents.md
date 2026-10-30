# Settings › Agents: agent runtime, Claude accounts, Action Log and Approvals

**Status:** shipped
**Design:** Settings › Agents in `design/ops-console.html` (accounts list, Auto-switch, Smart usage, default model, effort and access), plus the Session composer chips (Model, Effort, Access) and the approval prompts those settings drive

## Problem

The rest of the console relies on the agent, and every later spec needs the same pieces from it. A Session needs a place to run, a way to resume after a reload, and output that streams to the browser. The operator needs to know what the agent did outside its own process, and needs to say yes before it writes to PROD. The operator also works on more than one Claude subscription. The Agents tab shows each account's 5-hour and weekly usage, and can move Sessions to another account when the active one runs low, without losing the conversation.

This spec builds the agent runtime, the core of a Session, the Action Log, Approvals and the Agents tab. Kind-specific Sessions (`repo`, `pr_review`, `devtools`) come later, in `07-workspace` and `09-dev-tools-agent`. Daemon, storage, envelopes, the `settings` table, the start-up hook and the `claude` CLI wrapper come from `01-base-daemon-setup`.

## Behavior

Sessions and runs

1. A new Session takes its model, effort and access mode from the `session_defaults` setting unless the creating spec passes them. Its state is `idle` and its title is "New session" until the first message, whose first line (cut to 60 characters) becomes the title.
2. The first message starts a Claude Agent SDK run under the active Claude account, in the working directory the Session's kind supplies. The run's SDK session id and the account are stored on the Session. Later messages resume that SDK session.
3. The console stores no messages. Listing a Session's messages reads the transcript through the SDK from the Session's account, oldest first, and maps user and assistant entries to `Message`s with parts: text to `text`, tool calls to `step`, file edits to `diff`, code blocks to `code`, the agent's questions to `question`.
4. While a run streams, each part goes out as `session.output`. A part that grows is resent whole with the same `part_index`. The in-flight agent message lives in the daemon's memory: listing during a run returns it as `streaming`, and after a reload mid-run the next `session.output` continues from the next `part_index`.
5. A run that ends sets the Session `idle`, or `failed` when the run errored, updates `last_message_preview` and `last_active_at`, and sends `session.finished`.
6. A Session whose transcript is gone (deleted outside the console) lists no messages. Its next message starts a new SDK session and replaces `sdk_session_id`.
7. A message to a Session whose run is still going is refused with `session_busy`. Runs of different Sessions go on side by side.
8. When the agent asks the operator a question, the Session is `waiting_input` and the question shows as a `question` part. The operator's next message answers it and sets the Session `working`.
9. Access modes map to SDK permission modes:
   - `supervised` (`default`): every edit and every command that needs approval creates an Approval of kind `edit` or `command` and sets the Session `waiting_approval`.
   - `accept_edits` (`acceptEdits`): file edits inside the working directory run; commands still ask.
   - `auto` (`auto`): the SDK's classifier runs edits and safe commands and asks for risky ones.
   - `full` (`bypassPermissions`): edits and commands run without asking.
10. Changing a Session's model, effort or access mode applies from its next run.
11. Deleting a Session removes its row. The transcript stays where Claude Code keeps it. Action Log rows and Approvals stay and lose their `session_id`. Deleting a Session whose run is going is refused with `session_busy`.

Guards, Action Log and Approvals

12. No access mode skips a PROD write. A `PreToolUse` hook checks every tool call against the PROD-write rule (`05-settings-dev-tools` supplies it; until then it matches nothing) and holds a match for an Approval of kind `prod_write`, in every mode, `full` included.
13. No Session can merge. The Git host merge commands (`gh pr merge`, `glab mr merge`) and any Git host MCP tool that merges are denied in every mode, and the agent gets a denial it can read.
14. Before every Bash call and every MCP tool call runs, an Action Log row exists with outcome `pending`. After the call the row is `ok` or `failed`; a call the operator denied is `denied`. Kind comes from the call: Bash `git …` is `git`, `gh pr …` and `glab mr …` are `pr`, other Bash is `shell`, a Slack tool is `message`, an Atlassian issue tool is `ticket`, any other MCP tool is `query`.
15. Commands are redacted before they are stored: values that look like secrets become `[redacted]`.
16. The Action Log has no update or delete endpoint.
17. Approving a pending Approval lets the call run; denying it sets the Action Log row `denied` and tells the agent no. Deciding an Approval that is not `pending` is refused with `invalid_state`.
18. On daemon start, Sessions left `working`, `waiting_input` or `waiting_approval` become `failed`, and `pending` Approvals become `expired` with their Action Log row `failed` and `error_message` `interrupted`. This runs in the start-up hook from `01-base-daemon-setup`.

Claude accounts

19. First start has no Claude account and no active account (`active_account_id` is `null`). The operator adds one; the first account to sign in becomes active, with no `account.switched` event. A message sent while no account is signed in is refused with `invalid_state`.
20. Adding an account takes no input. It creates a config dir under the data directory, labels the account `New account` and returns the sign-in command for that dir. The account's label is the email Claude reports: each check that finds an email sets it. Signing in an account runs `claude auth login` with that dir: the CLI opens the browser and the daemon waits up to 5 minutes, then checks the account. While it waits the account reads `signing_in`; cancelling stops it. A Claude account is added once: an account whose check finds the email of another signed-in account is signed out again with `invalid_state`, and a new one is deleted. The tab shows nothing about it. A new account that never signed in is deleted when its sign-in is cancelled, declined, fails or times out. A shell credential (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) never reaches an added account's CLI or runs, because it would override the account's own sign-in. The sign-in completes in Anthropic's own flow; the console never reads, stores or passes on a Claude token.
21. Checking an account runs the `claude` CLI's sign-in status with that account's config dir and stores `signed_in`, `email` and `plan`. The active account is always signed in, or there is none. When there is no active account, or the active one is signed out, an account that checks as signed in becomes active. An active account that checks as signed out hands over to another signed-in account, or leaves none active.
21a. Signing an account out runs `claude auth logout` with its config dir, then checks it (Behavior 21). A run going on the account refuses it with `invalid_state`.
22. Each rate-limit event from a run updates that account's 5-hour and weekly usage percentages, their reset times and `usage_seen_at`. A window past its reset time reads 0%. An account with no usage read yet reads usage unknown.
22a. The daemon also reads the usage of each signed-in account on start, right after the account signs in, and every 5 minutes. It asks a Claude Code process under the account's config dir for its `/usage` numbers, which sends nothing to the model and spends no quota. The result is stored like a rate-limit event (Behaviors 22 and 24), so an idle account shows its 5-hour and weekly usage. A read that fails or returns no limits keeps the last values.
23. Using an account makes it active. A run in progress finishes on its own account. The next run of a Session that ran under another account first copies the Session's transcript into the new account's config dir, so the conversation carries over, then resumes there. `account.switched` reports the change with reason `manual`, or `smart` when the account used is the Smart pick.
24. With Smart usage on, the daemon makes the Smart pick the active account on its own, whenever usage is stored (Behaviors 22 and 22a), an account signs in, or Smart usage is turned on. The reason is `smart`. With Smart usage off and Auto-switch on, when the active account's 5-hour usage reaches the threshold (default 95%), the daemon makes the signed-in account with the lowest known 5-hour usage under the threshold active. The reason is `auto` with the percentage. With no candidate, the active account stays. Using an account by hand holds until the next stored usage; to stop the daemon moving off it, the operator turns Smart usage off.
25. Smart rank: candidates are signed in, have known usage, a 5-hour usage under the threshold and a weekly usage under 100%. Score is (100 − weekly %) ÷ days until the weekly reset; highest first. When Smart usage is on and there is a top pick, the account list carries `smart_pick` and its reason, whether or not the pick is already active.
26. A run rejected because its account hit a limit resumes once on a new account when Auto-switch picked one. The switch reason is `rate_limited`. Otherwise the Session ends `failed` with `rate_limited`.
27. Removing an account signs it out of its config dir when it is signed in, deletes the row and its config dir, and sends `account.removed`; each Session on it gets its transcript copied to the active account first. Removing the active account hands over to another signed-in account, or leaves none active. An account with a run going is refused with `invalid_state`.
28. The `agent_accounts` setting holds the active account, Auto-switch on or off, the threshold and Smart usage on or off. A threshold outside 50 to 100 is refused with `validation_failed`.

## Settled

- **Runtime**: `@anthropic-ai/claude-agent-sdk` `query()` with `resume` set to the stored SDK session id. The run's `env` carries the account's `CLAUDE_CONFIG_DIR`.
- **Transcript reads**: `getSessionMessages()` with the run's working directory, under the Session's account. Documented in the SDK.
- **Moving a transcript**: copying the session file into another config dir's `projects/` before `resume` is the documented way to resume elsewhere.
- **Parts**: `text`, `step`, `diff`, `code`, `question`. `finding` belongs to `07-workspace`.
- **Guards**: the PROD-write check and the Action Log write are `PreToolUse` hooks, which run before every other permission step and can deny even in `bypassPermissions`. The merge denial is a scoped `disallowedTools` rule, which holds in every mode. `supervised` prompts reach `canUseTool`.
- **Action Log scope**: every Bash call and every MCP tool call. File reads and edits inside the working directory are not logged; the diff shows them.
- **Approval kinds**: `prod_write` (hook), `command` and `edit` (permission prompts in `supervised`, or `auto` asking). An agent question is not an Approval; it is `waiting_input`.
- **Claude accounts**: one config dir per account at `<data directory>/accounts/<id>`. The console never uses the operator's own `~/.claude` login. Everything Claude Code keeps per config dir (sign-in, transcripts, MCP servers, settings) is per account.
- **Usage source**: two sources, both through Claude Code. First, the SDK's rate-limit event from a run. Its documented fields are a status, one utilization and one reset time; the per-window 5-hour and weekly numbers sit in fields the SDK does not document (`rateLimitType`, `unifiedWindows`). The console reads those and keeps the last values when they are missing. Second, for idle accounts, the SDK's usage request (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) on a Claude Code process that never receives a prompt; Claude Code reads the token and calls Anthropic itself, and returns the same 5-hour and weekly windows `/usage` shows. T3 Code reads usage the same way. Claude Code's status line documents the same two windows; the console does not use the status line.
- **Rejected source for usage**: calling the `api/oauth/usage` endpoint from the console, as some menu-bar tools do. It needs the account's OAuth token, which the console must not read. That endpoint also answers 429 to frequent callers, and Claude Code itself holds off for minutes after one; this is why the poll is every 5 minutes, not every few seconds.
- **Account label**: the email Claude reports. The operator types nothing when adding an account.
- **Sign-in**: Anthropic's own browser flow, started by the daemon (`claude auth login`). The console shows Sign in, Re-login, Cancel and Log out; a pasted code is not supported. If the operator declines in the browser, the CLI never reports it, so the account waits until Cancel or the 5-minute timeout.
- **Smart usage acts by itself**: turning it on is the operator's approval to switch to the Smart pick without asking. Turning it off stops that. Its switch can undo a manual Use at the next stored usage.
- **Settings hook**: a registered setting may carry an `onChange` callback that `PATCH /settings` calls once the new value is stored. `agent_accounts` uses it so turning Smart usage on switches at once.
- **Defaults**: `session_defaults` is `{ "model": "claude-sonnet-5-5", "effort": "high", "access_mode": "supervised" }`. `agent_accounts` starts as Auto-switch on, threshold 95, Smart usage on, matching the design.
- **Design departure reversed**: `docs/architecture.md` lists account rotation as out until Anthropic's terms are checked. The operator chose the full tab; `/ship` updates `architecture.md` and records the risk in Safety below.
- **Concurrency**: one run per Session at a time (`session_busy`); a switch of the active account never moves a run in progress.

## Not required

- **Second-by-second usage**: an idle account's numbers are at most 5 minutes old. The tab re-reads the console's copy every 10 seconds and shows `usage_seen_at`.
- **Exact usage**: the per-window numbers come from undocumented SDK fields and an experimental SDK request, and can disappear in an SDK release. The tab then shows the last values with their age.
- **WebFetch and WebSearch in the Action Log**: not logged.
- **Waiting through a restart**: a run does not survive a daemon restart, so its Approval expires (Behavior 18). The operator sends the message again.
- **History without Claude Code**: if the transcript is deleted, the Session's history is gone (Behavior 6).
- **Terms of service**: Auto-switch and Smart usage may be read as getting around usage limits. Nothing here can rule that out; the operator accepted the risk (Safety).

## Safety

- The agent never gets a merge tool, in any access mode (ADR 0002). Merge stays an operator endpoint in `07-workspace`.
- A PROD write needs an Approval in every access mode, `full` included.
- Every Bash and MCP tool call is logged before it runs. Commands are redacted on write.
- The console never reads, stores or passes on a Claude.ai token. Sign-in runs in Anthropic's own flow, and usage comes from the SDK's own events and usage request. Anthropic's Claude Code legal page says developers "may not collect, store, or intermediate Claude.ai credentials or session tokens" (<https://code.claude.com/docs/en/legal-and-compliance>).
- **Terms risk of Auto-switch and Smart usage.** The Consumer Terms (effective October 8, 2025) do not mention multiple accounts, but they forbid "bypassing any of our systems or protective measures" (<https://www.anthropic.com/legal/consumer-terms>). The Claude Code legal page says advertised Pro and Max limits "assume ordinary, individual usage of Claude Code and the Agent SDK". Moving work to a second account when the first nears its limit can be read as bypassing a limit. Secondary reports describe bans of people using several Max accounts this way; there is no Anthropic statement. Agent SDK runs signed in with a plan draw from that plan's limits (<https://support.claude.com/en/articles/15036540>). The operator accepted this risk; both toggles stay off-able, and turning them off leaves one active account like plain Claude Code.

## Database

```sql
CREATE TABLE claude_accounts (
  id                   TEXT PRIMARY KEY NOT NULL,
  label                TEXT NOT NULL,            -- the account's email once known; `New account` before
  config_dir           TEXT,                     -- CLAUDE_CONFIG_DIR, set on every row
  position             INTEGER NOT NULL,         -- order in the list
  signed_in            INTEGER NOT NULL DEFAULT 0 CHECK (signed_in IN (0, 1)),
  email                TEXT,                     -- from the CLI's sign-in status
  plan                 TEXT,                     -- as the CLI reports it, for example 'Max 20x'
  five_hour_pct        REAL,                     -- null: unknown
  five_hour_resets_at  TEXT,
  weekly_pct           REAL,
  weekly_resets_at     TEXT,
  usage_seen_at        TEXT,
  last_checked_at      TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX claude_accounts_config_dir_idx ON claude_accounts (ifnull(config_dir, ''));

CREATE TABLE sessions (
  id                    TEXT PRIMARY KEY NOT NULL,
  kind                  TEXT NOT NULL,           -- SessionKind
  title                 TEXT NOT NULL,
  model                 TEXT NOT NULL,           -- Model
  effort                TEXT NOT NULL,           -- Effort
  access_mode           TEXT NOT NULL,           -- AccessMode
  account_id            TEXT REFERENCES claude_accounts (id) ON DELETE RESTRICT,  -- holds the transcript; null before the first run
  sdk_session_id        TEXT,                    -- Claude Agent SDK session; its transcript holds the messages
  state                 TEXT NOT NULL DEFAULT 'idle',  -- SessionState
  last_message_preview  TEXT,                    -- first line of the newest message
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_active_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX sessions_active_idx ON sessions (last_active_at DESC);

CREATE TABLE action_log (
  id             TEXT PRIMARY KEY NOT NULL,
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor          TEXT NOT NULL,                  -- ActionActor
  kind           TEXT NOT NULL,                  -- ActionKind
  session_id     TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  target         TEXT NOT NULL,                  -- what it touched: server name, channel, repo#pr, ticket key, working dir
  command        TEXT NOT NULL,                  -- redacted
  is_prod        INTEGER NOT NULL DEFAULT 0 CHECK (is_prod IN (0, 1)),
  outcome        TEXT NOT NULL DEFAULT 'pending',  -- ActionOutcome
  error_message  TEXT,                           -- 'interrupted' when a restart ended the wait
  finished_at    TEXT
) STRICT;
CREATE INDEX action_log_at_idx ON action_log (at DESC);
CREATE INDEX action_log_session_idx ON action_log (session_id, at);

CREATE TABLE approvals (
  id             TEXT PRIMARY KEY NOT NULL,
  action_log_id  TEXT UNIQUE REFERENCES action_log (id) ON DELETE CASCADE,  -- null for an edit: the Action Log does not record edits
  session_id     TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  kind           TEXT NOT NULL,                  -- ApprovalKind
  summary        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',  -- ApprovalStatus
  requested_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at     TEXT
) STRICT;
CREATE INDEX approvals_pending_idx ON approvals (requested_at) WHERE status = 'pending';
```

Later specs add columns with `ALTER TABLE … ADD COLUMN`: `sessions.repo_id`, `branch`, `alert_id`, `pr_number` and the Connection scope (`07-workspace`, `08-monitor-dashboard`, `09-dev-tools-agent`); `action_log.connection_id` (`05-settings-dev-tools`) and `action_log.alert_id` (`08-monitor-dashboard`), each a nullable reference with no default. A plain id without a foreign key was the alternative; a reference keeps `ON DELETE SET NULL` working.

Enums live in code only (`01-base-daemon-setup`):

| Enum | Values | Columns |
| ---- | ------ | ------- |
| `SessionKind` | `repo`, `devtools`, `pr_review` | `sessions.kind` |
| `Model` | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1` | `sessions.model` |
| `Effort` | `low`, `medium`, `high`, `xhigh`, `max`, `ultrathink` | `sessions.effort` |
| `AccessMode` | `supervised`, `accept_edits`, `auto`, `full` | `sessions.access_mode` |
| `SessionState` | `idle`, `working`, `waiting_input`, `waiting_approval`, `failed` | `sessions.state` |
| `ActionActor` | `agent`, `operator` | `action_log.actor` |
| `ActionKind` | `query`, `shell`, `message`, `git`, `pr`, `ticket` | `action_log.kind` |
| `ActionOutcome` | `pending`, `ok`, `failed`, `denied` | `action_log.outcome` |
| `ApprovalKind` | `prod_write`, `command`, `edit` | `approvals.kind` |
| `ApprovalStatus` | `pending`, `approved`, `denied`, `expired` | `approvals.status` |
| `SwitchReason` | `manual`, `auto`, `smart`, `rate_limited` | `account.switched` event |

Migration: no existing rows. A database from the build that seeded a `default` account (no `config_dir`) loses that row: it is deleted, its Sessions lose their account, and the first signed-in added account becomes active. The migration creates the tables in the order above and the `settings` keys `session_defaults` (Settled) and `agent_accounts` `{ "active_account_id": null, "auto_switch": true, "threshold": 95, "smart_usage": true }`.

## API

### Common

Envelopes, auth and shared error codes come from `01-base-daemon-setup`. This spec adds one code:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `session_busy` | The Session's run is still going |

`Part`:

```json
{ "kind": "text",     "text": "string" }
{ "kind": "step",     "text": "string" }
{ "kind": "diff",     "file": "string", "lines": [{ "sign": "+ | - | ' '", "text": "string" }] }
{ "kind": "code",     "lang": "string", "text": "string" }
{ "kind": "question", "text": "string", "options": ["string"] }
```

`Session`: every `sessions` column except `sdk_session_id`, plus the columns later specs add.

`Message`, read from the transcript: `id` (the transcript entry id), `role` (`user | agent`), `status` (`streaming | done | failed`), `parts: Part[]`, `created_at`.

`ClaudeAccount`: every `claude_accounts` column except `config_dir`, plus `is_active`, `signing_in` (a sign-in is waiting; held in memory), and `smart_note` when Smart usage is on (for example "5-hour window nearly full, skipped" or "65% weekly left ÷ 2d = 32.5% / day").

### Sessions

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /sessions` | query `kind?`, `q?` (title search) | `Session[]`, newest `last_active_at` first |
| `GET /sessions/:id` | | `Session` |
| `PATCH /sessions/:id` | `{ title?, model?, effort?, access_mode? }` | `Session` |
| `DELETE /sessions/:id` | | 204; `session_busy` |
| `GET /sessions/:id/messages` | | `Message[]` oldest first, the in-flight message included; empty with no transcript |

`POST /sessions` is defined by each kind's spec. This spec gives them the shared creation step (Behavior 1).

### `POST /sessions/:id/messages`

```json
{ "text": "string" }
```

Returns 202 with `{ "data": { "message_id": "string" } }`. The reply arrives through `session.output`. Errors: `session_busy`; `invalid_state` when the kind's spec forbids messages (`pr_review`).

### Approvals and Action Log

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /approvals` | query `status?` | `Approval[]` with the Action Log row's `target`, `command` and `is_prod`; an edit has none, so `null`, `null`, `false` |
| `POST /approvals/:id/decision` | `{ "decision": "approved \| denied" }` | `Approval`; `invalid_state` unless `pending` |
| `GET /action-log` | query `session_id?`, `kind?`, `is_prod?`, `outcome?` | rows, newest first |

### Claude accounts

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /agent-accounts` | | `ClaudeAccount[]` by `position`. `meta` adds `active_account_id` (`null` with no account) and `smart_pick: { account_id, reason } \| null` |
| `POST /agent-accounts` | none | 201 `{ account: ClaudeAccount, sign_in_command: "string" }` |
| `POST /agent-accounts/:id/checks` | | `ClaudeAccount` after the CLI's sign-in status |
| `POST /agent-accounts/:id/logout` | | `ClaudeAccount` after the sign-out; `invalid_state` (Behavior 21a) |
| `POST /agent-accounts/:id/logins` | | `ClaudeAccount` with `signing_in: true`; the account is checked when the sign-in ends |
| `DELETE /agent-accounts/:id/logins` | | 204; stops a waiting sign-in |
| `POST /agent-accounts/:id/activate` | | `ClaudeAccount`; `invalid_state` unless signed in |
| `DELETE /agent-accounts/:id` | | 204; `invalid_state` (Behavior 27) |

Session defaults and the Auto-switch, threshold and Smart usage values change through `PATCH /settings` keys `session_defaults` and `agent_accounts` (`01-base-daemon-setup`), validated as in Behavior 28.

### WebSocket `session.output`

Server to client, when the agent appends or grows a part.

```json
{ "session_id": "uuid", "message_id": "string", "part_index": 0, "part": "Part" }
```

### WebSocket `session.finished`

Server to client, when a run ends.

```json
{ "session_id": "uuid", "message_id": "string", "status": "done | failed", "state": "idle | failed", "error_code": "string | null" }
```

### WebSocket `session.updated`

Server to client, when a Session's title, state, account or settings change.

```json
{ "session_id": "uuid", "title": "string", "state": "SessionState", "account_id": "uuid | null" }
```

### WebSocket `approval.requested`

Server to client, when an Approval is created.

```json
{ "approval_id": "uuid", "session_id": "uuid | null", "kind": "ApprovalKind", "summary": "string", "is_prod": true }
```

### WebSocket `approval.decided`

Server to client, when the operator decides or a restart expires it.

```json
{ "approval_id": "uuid", "decision": "approved | denied | expired" }
```

### WebSocket `action.logged`

Server to client, when an Action Log row is created and again when its outcome is set.

```json
{ "id": "uuid", "kind": "ActionKind", "target": "string", "is_prod": false, "outcome": "ActionOutcome" }
```

### WebSocket `account.removed`

Server to client, when an account is deleted, including an abandoned first sign-in.

```json
{ "account_id": "uuid" }
```

### WebSocket `account.updated`

Server to client, when an account's sign-in or usage changes.

```json
{ "account_id": "uuid", "signed_in": true, "five_hour_pct": 0, "weekly_pct": 0, "usage_seen_at": "string | null" }
```

### WebSocket `account.switched`

Server to client, when the active account changes.

```json
{ "from": "uuid", "to": "uuid", "reason": "SwitchReason", "five_hour_pct": 0 }
```

## UI

Settings › Agents, as the design shows:

- **Accounts**: rows in order (01, 02, …) labelled with the account's email, plan, a 5-hour bar with "resets in", and a weekly bar with "resets in Nd". The 5-hour bar turns accent at 90%, the weekly bar at 80%. The active row is shaded; others have Use. "SMART PICK" marks the pick, and each row shows its `smart_note`. The tab re-reads the accounts every 10 seconds while it is open. A signed-in row always shows both bars; with usage unknown the bars are empty and read "no usage yet". Only a signed-in active row is shaded and badged ACTIVE. A row not signed in shows Sign in, which opens Anthropic's sign-in in the browser; while it waits the row shows Re-login, which opens the browser sign-in again, and Cancel, which also deletes an account that never signed in.
- **Smart banner**: when `smart_pick` is set and there is more than one account, the reason ("65% of its weekly quota is left and it resets in 2 days, use it first") and a line that it is used automatically while Smart usage is on. No Use button; the pick row carries SMART PICK.
- **Auto-switch accounts**: toggle and threshold. Text: "When the active account reaches 95% of its usage window, the session moves to the next account with headroom. Context carries over."
- **Smart usage**: toggle. Text: "Uses the account whose weekly quota would otherwise go unused first: weekly % left ÷ days until weekly reset. Accounts with a full 5-hour window are skipped."
- **No account yet**: the tab holds a short note and Add Claude account, nothing else.
- **Accounts, none signed in**: the account list and Add Claude account show under a banner that says to sign in. Auto-switch, Smart usage, and the defaults appear once one account is signed in.
- **Row actions**: a signed-in row has Use (when not active), Re-login and Log out. Re-login runs the same browser sign-in; Log out is Behavior 21a. Every row except one waiting for sign-in has a trash icon that removes the account (Behavior 27); a waiting row has Cancel instead.
- **Add Claude account**: one button. It adds the account and starts its sign-in; the row shows the Claude email once the sign-in finishes.
- **Defaults**: Default model, Default effort, Default access, with the design's descriptions.
- **Session composer chips** (Model, Effort, Access) write `PATCH /sessions/:id`. Approval prompts list pending Approvals with the command and a PROD badge.
- States: loading; error from `GET /agent-accounts` with Retry; one account only hides the Smart banner.
- Each switch leaves a line in the Session's output: "⇄ Smart usage: operator → operator.personal · session context carried over", built from `account.switched` (the reason reads "Smart usage", "Auto-switch at 95%", "Switched manually" or "Rate limit"), not stored.

## Rejected

- **A label the operator types**: Claude already reports the email, and a second name drifts from it.
- **A Use button on the Smart pick**: the operator approved the switch by turning Smart usage on.
- **An Other agents section with Codex**: nothing behind it; it returns with the spec that adds Codex.
- **Reading usage from `api/oauth/usage`**: undocumented, rate limited for other clients, and it needs the account's OAuth token, which Anthropic's legal page forbids third-party tools to collect.
- **Polling usage with a small run per account**: spends quota to measure quota, and still relies on the same undocumented fields.
- **Storing messages**: the transcript is the only copy; a second one drifts when Claude Code compacts or the operator resumes the Session in a terminal.
- **One shared config dir with token swapping**: needs the console to handle Claude tokens.
- **Approval checks in `canUseTool` only**: `acceptEdits`, `auto` and `bypassPermissions` approve calls before the callback runs. Hooks run first in every mode.
- **Plain ids without foreign keys on `action_log`**: loses `ON DELETE SET NULL` when a Connection or Alert goes.

## Glossary

- **Claude account** (changed): One Claude subscription signed in on this machine, named by its email, with its own 5-hour and weekly usage windows. Each is added once. The agent runs under the active one.
- **Auto-switch** (changed): With Smart usage off, moving the active Claude account when its 5-hour usage reaches the threshold, carrying each Session's conversation over.
- **Smart usage** (changed): Ranking Claude accounts by weekly quota left per day until the weekly reset, so quota that would go unused is used first, and moving to the top pick on its own while it is on.
- **Access mode**: What the agent may do in a Session without asking: supervised, accept edits, auto or full. A PROD write asks in every mode.
- **Approval** (changed): The operator's yes or no on one agent action that needs it: a PROD write, or an edit or command in a mode that asks.

## Seams

- **Backend + SQLite, over HTTP** (temporary data directory, a fake Agent SDK that replays scripted runs and rate-limit events and serves transcripts, a fake `claude` CLI): 1, 2, 3, 5, 6, 7, 9, 10, 11, 16, 17, 18, 19, 20, 21, 21a, 22, 22a, 23, 24, 26, 27, 28. Sessions are created through the shared creation step the kind specs call.
- **Backend + SQLite, over WebSocket**: 4, 8, 12, 13, 14, 23, 24. Asserts streaming, the reload continuation, Approvals held in `full` mode, the merge denial, Action Log events and switch events.
- **Unit**: 15, 25. Redaction and the Smart rank.

## Out of scope

- Session kinds and their creation, working directories, Connection scope and the "go" shortcut: `07-workspace`, `09-dev-tools-agent`, `08-monitor-dashboard`.
- The PROD-write rule and Access Level launch arguments: `05-settings-dev-tools`.
- MCP registrations per account: `03-settings-mcp-servers` must register every server in every account's config dir, and register them on a new account after sign-in. Until then a new account's runs see no MCP servers.
- Pasting a sign-in code, and a terminal that runs the sign-in command: `07-workspace` if it is ever needed.
- Codex and other agents: a later spec.
- Daemon, storage, envelopes, the `settings` table, the start-up hook, the `claude` CLI wrapper: `01-base-daemon-setup`.
