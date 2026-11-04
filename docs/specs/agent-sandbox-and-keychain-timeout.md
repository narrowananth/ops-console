# Agent Sandbox and Keychain Timeout

**Status:** shipped
**Design:** none. Setup agent page, Permissions: gains two rows. The app shell gains a banner.

## Problem

An agent run executes commands as the operator. Nothing stops a command from reading the console's
`runtime.json`, taking its session token and calling the console's own API, which includes approving its
own Approvals. A run steered by a log line, or one that goes wrong on its own, can also write anywhere
the operator can: a bug-reproduction script with a runaway loop or a cleanup that deletes too much hits
the operator's real files.

Separately, a macOS Keychain prompt waits for a password on the Mac. A run that needs a secret hangs
until someone types it. Running with no one at the Mac, the operator sees a Session that does nothing and
no reason why.

## Behavior

### Run sandbox

1. Every agent run's shell commands run inside the Run sandbox: every Session kind, every Access mode,
   `full` included, every Playbook step turn and every chat turn. The Setup agent's terminal is not an agent
   run and is not sandboxed.
2. A run writes only in its working folder and in the temp folders (`/tmp`, `/private/tmp`). The working
   folder is the scratch copy for a Verification, Agent Review, Reply check and Comment pass, and the
   checkout for a Fix and for chats. A write anywhere else fails.
3. A run cannot read the live data folder (the one the daemon runs on, wherever
   `OPS_CONSOLE_DATA_DIR` or the dev folder puts it), `~/.aws`, `~/.config/gcloud` or the login
   Keychain folder. It also cannot read `~/.ssh`, except as item 4 says. The run's own working
   folder is readable even when it sits inside the data folder. So `runtime.json` and `state.db` are out of
   reach, and a run cannot call the console's API as the operator.
4. A Fix run may read `~/.ssh`, so its PR stage can push. A Fix starts only after the operator confirms the
   Report. Every other kind denies `~/.ssh`.
5. When the Run sandbox is unavailable, the run fails before its first command, and the Session shows why.
   No command ever runs outside the sandbox: the agent cannot ask to leave it in any Access mode, and
   there is no Setting that turns it off.
6. Two runs at once each write only in their own working folder. One run cannot write in another run's
   scratch copy.
7. A resumed conversation, a retried step and a run after a daemon restart get the same rules as a new run.
8. A blocked read or write shows in the transcript as an ordinary command failure and the run goes on;
   the agent may try another way. It does not fail the job by itself.
9. What the Playbooks run keeps working inside the sandbox: `git`, `gh`, `node`, `pnpm`, package
   installs and git fetches, the network being open. `gh` signs in through `GH_TOKEN`, set in the run's
   environment from the token the GitHub Connector holds, since the sandbox blocks the login Keychain `gh`
   otherwise reads it from. A run gets no `GH_TOKEN` while the Connector holds none. The files the operator
   attached to a Session stay readable. MCP Servers and Connections are unchanged, and a PROD write still
   waits for an Approval in every Access mode.
10. Setup agent > Permissions shows a read-only row, Run sandbox: on, or unavailable with the reason. The
    daemon tests the sandbox with a trivial command each time the row is read. The row has no control.

### Keychain wait

11. Each Keychain `get`, `set` and `delete` waits at most 60 seconds. At that point the call fails with
    `keychain_timeout`. If the operator answers the prompt later, the answer is thrown away. A late `set`
    may still store its value in the Keychain; the console does not use the result.
12. Keychain calls that wait for the version handover wait at most 90 seconds for it. After that they fail
    with `keychain_timeout`. The handover itself keeps running. The 60 seconds of item 11 start after the
    handover is done.
13. A `keychain_timeout` ends the running Playbook step `failed` with "Keychain is waiting for the Mac's
    password prompt", and a failed step stops its job. The console does not retry on its own. The operator
    retries the job after answering the prompt. A run that needs a secret before it starts, such as the
    CLIProxy key, fails to start with the same message.
14. A Keychain call pending past 10 seconds shows a banner on every page, "Keychain is waiting for the Mac's
    password prompt", and the same state on the Permissions page. It clears when every pending call has
    ended or timed out. A call that ends in under 10 seconds shows nothing.
15. Reloading a page mid-wait shows the banner again. Every open browser shows it. A daemon restart clears
    it.
16. No Keychain behavior otherwise changes: the items, the `ops-console-dev` split for `pnpm dev` and the
    handover stay as they are. No secret reaches the error text, the banner or a WebSocket payload.

## Settled

- **Run sandbox**: the Claude Agent SDK's own `sandbox` option, which on macOS uses Seatbelt. The console
  sets rules, not profile text. `failIfUnavailable` is on and unsandboxed commands are off.
- **Rules**: fixed in code, not Settings. They are built per run from its working folder, the data folder
  in use and the run's kind.
- **Network**: open. A run steered by log text can still send out what it can read.
- **MCP Servers and the daemon**: not sandboxed. The daemon's Keychain reads and the MCP Servers Claude
  Code starts run outside the Run sandbox, so a Connection still reaches the agent through its MCP Server.
- **Keychain timers**: in the daemon, around each call. The native call cannot be cancelled.
- **Keychain failure code**: `keychain_timeout`.
- **Wait state**: in daemon memory; the oldest pending call sets its start. Two pending calls make one banner.
- **`gh` in the sandbox**: checked against the real SDK sandbox. `gh` fails there for two reasons: its token
  sits in the login Keychain, and Go's certificate check needs macOS's trust service. The run therefore gets
  `GH_TOKEN`, and the sandbox sets `enableWeakerNetworkIsolation`, which opens that one service. The operator chose
  `GH_TOKEN` over excluding `gh` from the sandbox.
- **Prod**: the PROD-write rule and Access Levels are untouched.

## Not required

- **A network allowlist**: this spec leaves the network open. [run-network-allowlist](run-network-allowlist.md) adds one.
- **`mcp-exec` and the Setup agent's Keychain reads**: they run in their own processes with their own
  waits, and the 10-second banner does not see them. The Setup agent's reads keep their 120-second limit.
- **Cancelling the native Keychain prompt**: the dialog stays on the Mac until answered or dismissed.
- **Automatic retry** after a Keychain timeout.
- **A late `set` rolled back**: it may land after the timeout.
- **`pup` in a run's shell**: it keeps its Datadog sign-in in the login Keychain, so inside the sandbox it
  cannot read it. The Playbooks reach Datadog through its MCP Server, which stays outside the sandbox.
- **Credential rotation**: the console never rotates credentials, so no rotation prompt is handled.

## Safety

The agent's reach shrinks, with one addition. It loses writes outside its working folder and the temp
folders, and reads of the data folder, `~/.aws`, `~/.config/gcloud`, the login Keychain folder and, outside a
Fix, `~/.ssh`. A Fix run keeps `~/.ssh`. Every run gains `GH_TOKEN`, the GitHub token the Connector holds, so
`gh` can sign in; the agent could already use that token through `gh`, and the open network could carry it out.
No new shell command is allowed, and no new Approval is added. The agent cannot lift the sandbox for any
command, and no operator control lifts it. ADR 0002 and ADR 0003 hold.

## API

### Common

Errors:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 503 | `keychain_timeout` | A Keychain call or the wait for the handover passed its limit |

### `GET /terminals/run-sandbox`

Next to `disk-access` and `start-at-login`. Tests the sandbox, then answers:

```json
{
  "status": "on | unavailable",
  "reason": "string | null"
}
```

- `reason`: why the sandbox is unavailable; null when `on`.

### `GET /terminals/keychain-wait`

Answers from daemon memory:

```json
{
  "waiting": false,
  "since": "ISO 8601 | null",
  "pending": 0
}
```

- `waiting`: true once a call has been pending past 10 seconds.
- `since`: when the oldest pending call began.
- `pending`: calls still pending.

### `GET /sessions/:id`, `GET /sessions`

Each Session gains one field, `last_error`: the message of the run that failed last when the console can say why
(the Run sandbox is unavailable, or `keychain_timeout`), else null. The daemon keeps it in memory: the Session's next
run and a restart clear it.

```json
{ "last_error": "string | null" }
```

### WebSocket `keychain.wait_changed`

Server to client. Fires when the first call passes 10 seconds, when `pending` changes while `waiting` is
true, and once with `waiting` false when the last pending call ends or times out.

```json
{ "waiting": true, "since": "ISO 8601 | null", "pending": 1 }
```

## UI

- **App shell banner**: on every page, above the page. States: hidden; shown with "Keychain is waiting for
  the Mac's password prompt" and, below it, "Answer it on the Mac." It has no close button and goes away
  when `waiting` turns false. Follows no design screen.
- **Setup agent > Permissions**: two rows beside Full Disk Access and Start at login. Run sandbox: loading,
  on, unavailable with the reason, and an error row when the read fails. Keychain: idle, waiting with the
  time since, and the same text as the banner. Neither row has a control. In a dev build the rows read the
  dev daemon's state. Departs from the design, as Permissions already does.
- **Session and Playbook step**: a step that fails on `keychain_timeout` shows the message on the step, with the
  existing retry. A Session whose last run failed for that reason, or because the Run sandbox is unavailable, shows
  `last_error` in a note above the message box.

## Rejected

- **Docker or a micro-VM**: adds an install step to `curl | sh`, and the run could no longer reach the
  host's Keychain-backed CLIs, `pup`, `gh` or the operator's checkout.
- **A hand-written Seatbelt profile**: a `(deny default)` profile also blocks what `node`, `git` and `pnpm`
  read to start, and the SDK already ships a maintained base profile.
- **A network allowlist now**: package installs, git fetches and `pup` would need a list the operator keeps.
  It is a later spec.
- **An operator toggle or an "unsandboxed" retry**: the escape hatch is what the sandbox exists to remove.
- **Denying `~/.ssh` in a Fix**: breaks the PR stage's push.
- **An out-of-process guard for the Keychain**: a timer in the daemon does the job, the native call is not
  cancellable either way.
- **The warning on Permissions only**: the prompt stalls runs on any page, and the operator is rarely on
  Permissions then.

## Glossary

- **Run sandbox**: the operating-system limit on an agent run's commands: writes only in the run's working
  folder and temp, no reads of the console's data folder or the operator's cloud and login credentials.
  Applies in every Access mode.
- **Keychain wait**: a Keychain call the Mac has not answered, usually because it waits for the login
  password. Shown after 10 seconds, failed after 60.

## ADR

- **0006, Agent runs are sandboxed by the OS**: runs use the SDK's Seatbelt sandbox, fail closed, in every
  Access mode. The trade-off is an open network, so a steered run can still send out what it can read, in
  return for no allowlist for the operator to keep. Edit the Consequences of ADR 0002 in place: the Run
  sandbox now bounds a steered run, next to the safety lines, the Access mode and the scratch copy.

## Seams

- **Run options** (backend + SQLite, through the agent runtime with a fake SDK that records its options):
  1, 2, 3, 4, 5, 6, 7, 8, 9.
- **Real sandbox** (backend, macOS only): 2, 3, 5, 8, 9. A command run under the sandbox cannot read
  `runtime.json`, cannot write outside its working folder, and `git` and `node` still run.
- **Keychain timeouts** (unit, fake timers and a fake native call): 11, 12, 16.
- **Keychain failure and wait state** (backend + SQLite): 13, 14, 15.
- **Banner and Permissions rows** (frontend component): 10, 14, 15.

## Out of scope

- A network allowlist for agent runs. Own spec.
- `local-db-reproduction`: a local database of the same engine for reproductions. Own spec.
- Bounding and showing the Keychain waits of `mcp-exec` and the Setup agent.
