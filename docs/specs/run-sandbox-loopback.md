# Run sandbox loopback

**Status:** shipped
**Design:** none. Permissions: gains one row under Network allowlist. Permissions already departs from the design.

## Problem

A run's commands cannot start a server or call one, even on this Mac's own `localhost`. The agent can start a dev server through the Terminals dock and open its page, but a test runner that starts its own server, a `curl` to the server the Session runs, or a Playwright run against it fails inside the Run sandbox. The operator has no way to allow it. The Network allowlist spec left this for its own spec.

## Behavior

### What the switch does

1. Permissions shows a row "Loopback" under Network allowlist, with an on/off switch. It is off on a new install and after an upgrade.
2. Off: a run's commands cannot start a server on any address and cannot connect to any `localhost` port, as before.
3. On: a run's commands can start a server on `127.0.0.1` or on every address (`0.0.0.0`), and can connect to any `localhost` port, the server they started and every other local service alike. Unix sockets, DNS lookups, any host off the Network allowlist and a client that ignores the proxy settings stay refused.
4. The switch changes nothing else about a run. Access mode, Approvals, the PROD write rule, the Run sandbox's file rules and the Network allowlist behave as before.

### Which runs

5. The switch applies to a run the operator started in a Session's chat: a message they sent, and a conversation they resume or an edited message they send. A Playbook step, a Verification, a Fix, a pull request review or Comment pass, a read-only run, the first turn of a Session an agent started with `spawn_sessions`, and the Setup agent's terminal never get loopback, whatever the switch says.
6. A run keeps the value the switch had when it started. A change reaches the next run. A resumed conversation, a retried step and a run after a daemon restart read the switch again when they start. Two runs started on either side of a change can differ.
7. A run cannot change the switch: it cannot read the data folder or call the console's API as the operator.

### Turning it on and off

8. Turning the switch on asks first: "Commands the agent runs can start servers and reach every service on this Mac's localhost, such as databases. Turn on?" with Turn on and Cancel. Cancel leaves it off and saves nothing.
9. Turning the switch off asks nothing and saves at once.
10. The switch survives a reload and a daemon restart. Another browser that already has the page open shows the change after a reload.
11. A dev build (`pnpm dev`) keeps its own value in its own data folder.
12. While the console reads the switch the row shows it disabled. When it cannot read it the row says "Could not read the setting" with a retry. A save the console refuses puts the switch back and shows the message under the row.

### What the operator sees

13. While a run that has loopback is going, its Session shows a "Loopback on" chip in the Session header. A run without loopback, and a Session with no run going, show none.
14. The Running tray and the Agent runs page show the chip on the same run's entry while it goes.

### What must not regress

15. The Network allowlist, the Keychain timeouts, the `GH_TOKEN` sign-in and the refused-host handling behave as before. A command that fails because loopback is closed does not fail its job by itself.
16. A Session process (the Terminals dock) and the daemon are not sandboxed and behave as before.

## Settled

- **Mechanism**: the SDK's `network.allowLocalBinding`, set in the Run sandbox rules for a run that has loopback. On this Mac, with the real SDK sandbox: off, a bind on `127.0.0.1`, on `0.0.0.0` or on a Unix socket fails (`EPERM`) and `curl` to any local port exits 7; on, binds to `127.0.0.1` and `0.0.0.0` work, a command reaches its own server and another local port, and a Unix socket still fails.
- **One switch, not two**: the OS rule opens binding and reaching together, and cannot limit a command to its own server. "Its own servers only" is not offered.
- **Scope**: one console-wide switch, off by default, for chat runs only.
- **Stored as**: one Setting, `run_sandbox_loopback`, a JSON boolean. No table.
- **Chat run**: a message the operator sent in a Session, not a job's step, a review, a reply or a turn an agent started. It is the run that has an output folder, Opened Repos and the browser and process tools, and one test decides all of them. A Session an agent spawned runs its first turn without loopback; the operator's later messages in it get it.
- **Confirm**: on asks, off does not.
- **Chip**: shown while the run goes, read from the run, not stored.
- **ADR 0006**: edited in place.

## Not required

- **Closing the local services**: with loopback on, a run reaches every service on `localhost`: a database tunnel, local Postgres or Redis, the CLIProxy gateway, the dev stack and the console's own port. The console's API still needs the session token, which a run cannot read. Review flags code that tries to filter ports.
- **Listening on the network**: a server a run starts on `0.0.0.0` can be reached from the LAN, as any server the operator starts. The Mac's firewall decides.
- **A kept record**: a finished run shows no chip, and nothing records which runs had loopback.
- **Live sync**: other open browsers show an edited switch after a reload.
- **Unix sockets**: stay refused.

## Safety

The agent's reach grows, by the operator's choice, for chat runs only. Commands in a run with loopback can start servers and connect to every service on `localhost`. They gain no host beyond the Network allowlist and no file or credential. No new shell command is allowed, and no Approval is added or removed. The switch is off by default, asks before it turns on and can be changed only from the console. ADR 0002 and ADR 0003 hold. The PROD-write rule and Access Levels are untouched: a command that writes to PROD through a local tunnel still waits on the Access mode's rules, which do not see a local port, so the operator decides with the confirm text in front of them.

## Database

No table. One row in `settings`:

```sql
-- key `run_sandbox_loopback`, value `true` or `false` (JSON). No row means false.
```

No existing rows to migrate.

## API

### Common

Errors:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 400 | `validation_failed` | The value is not a boolean |

### `GET /settings`

The existing settings read gains one field:

```json
{ "run_sandbox_loopback": false }
```

### `PATCH /settings`

The existing request gains one optional key: `{ "run_sandbox_loopback": true }`. Answers as it does for the other settings. Errors: Common.

### Session

A Session gains `loopback`: `true` while a run that has loopback is going, `false` otherwise. A Running tray entry carries its Session, so it shows the same value.

## UI

Permissions: a row "Loopback" under Network allowlist, with a switch and one line of help: "Lets an agent run's commands start servers and reach every service on this Mac's localhost. Off by default." Departs from the design, as Permissions already does.

- **Loading**: the switch is disabled with a placeholder.
- **Error**: "Could not read the setting" with a retry.
- **Turning on**: a confirm dialog with Turn on and Cancel (Behavior 8).
- **Saving**: the switch shows the new value when the console answers; a refused save puts it back and shows the message under the row.
- **PROD**: changes nothing here.
- **Chip**: "Loopback on" in the Session header, the Running tray entry and the Agent runs row while the run goes (Behavior 13 and 14).

## Rejected

- **Its own servers only**: the OS rule cannot tell a command's own server from another local service.
- **A switch per Session**: more places to forget, and the rule that matters (chat runs only) is already per run.
- **On by default**: opens every local port for every chat run on upgrade.
- **Loopback for Verifications and Fixes**: they read PROD logs and run steered by log text; reaching a local database tunnel from there is the case the switch must not cover.
- **Dropping the switch for the Terminals dock alone**: the dock starts servers, but a run's own test runners and `curl` cannot reach them.
- **A kept record of which runs had loopback**: a table for a fact the operator sees while it matters.

## Glossary

- **Loopback**: the Run sandbox's one operator switch for a Session's chat runs: when on, the run's commands can start servers and reach every service on this Mac's `localhost`. Off by default.

## ADR

- **0006, Agent runs are sandboxed by the OS**: edit in place. The Run sandbox has one operator switch, Loopback, closed by default and open only for chat runs the operator started. The trade-off: the OS rule opens every local port and a listen on every address together, so a steered run in that state can reach a database tunnel or a local service; the closed default and the confirm are the guard.

## Seams

- **Run options** (backend + SQLite, Supertest, fake SDK that records its options; extend the Run sandbox test and the spawn test): 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 13, 14. Off sets nothing, on sets `allowLocalBinding` and nothing else for a chat run, a Playbook step, a Verification, a Fix, a review, a read-only run and a spawned Session's first turn never get it, a run keeps its value while it goes, Play, a restart and the next message read it again, and the Session carries `loopback` while the run goes.
- **Real sandbox** (backend, macOS only; extend the real-sandbox test): 2, 3, 15. Off refuses a bind on `127.0.0.1` or `0.0.0.0` and a connection to a local port; on lets a command start a server on either, reach it and reach another local port, and a Unix socket, a lookup and a host off the allowlist stay refused.
- **Browser** (Playwright; extend the Network allowlist, Agent runs and Workspace specs): 1, 8, 9, 10, 12, 13, 14. Against the real daemon: the row, the confirm and its Cancel, off without a confirm, the value after a reload, the loading, error and refused-save states. With the daemon's answers faked: the chip in the Session header, the Running tray and the Agent runs page.
- **Existing process and daemon tests** (unchanged): 16.

## Out of scope

- Limiting loopback to named ports. The OS rule does not allow it; a proxy of the daemon's own would. Own spec, if needed.
- Unix sockets, for a tool that talks to a local daemon over one (Docker).
- Making Node's `fetch` use the proxy (`NODE_USE_ENV_PROXY=1`). Own spec, as in the Network allowlist spec.
