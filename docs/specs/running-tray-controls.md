# Running tray controls

**Status:** shipped
**Design:** sidebar tray in `design/ops-console-sidebar.html`.

## Problem

The tray lists runs going, and nothing else. It does not say how long a run has gone, hides the subagents a run
started, and drops a run the moment it stops or runs out of usage, so the operator loses track of what to pick up.
Stop in a Session starts the queued message at once, which reads as "Stop did not work". A Scan cannot be stopped,
and a queued message cannot be sent before the run ends.

## Behavior

1. Each tray entry shows how long its run has gone, counting up, and how long it took once it ended.
2. A run that started subagents shows a fold with their count. Opened, it lists each subagent under the run with its
   description, type, status and time. A subagent started by a subagent sits under that one.
3. A run going has Pause and Stop. Pause ends the run like Stop and keeps it in the tray as paused.
4. A run that ended unfinished stays in the tray: stopped, paused, limit reached, signed out, failed or interrupted
   by a restart. Its chip says which, and the failure reason shows under it when the console has one.
5. A paused or stopped run has Play, which sends the agent "Carry on from where you stopped." A failed, limit-reached,
   signed-out or interrupted run has Retry, which asks the agent to try again. Neither shows for a pull request run
   the console started itself; those retry where they were started.
6. Dismiss takes an ended run out of the tray. A finished run leaves by itself. A new run in the Session replaces
   its entry.
7. An entry's link opens where the run shows: the Session, or the pull request for a pull request run.
8. Stop in a Session ends the run and holds the queued message. The note reads "On hold" until the operator clicks
   Send now. While the run goes, Send now stops it and sends the message. The daemon keeps the queued message
   (`agent-runs-page` Behavior 13).
9. The tray ends with a link to the Agent runs page (`agent-runs-page`).
10. While a Scan runs, Stop sits beside "Scanning…". It ends the read, keeps nothing the Scan read and ends the Scan
   `cancelled`. The line under the button says the last Scan was stopped.

## Not required

- **True pause**: the agent SDK cannot suspend a run. Pause ends the turn and Play starts the next from the same
  conversation.
- **Subagents after a restart**: they are kept with the run, but a run the restart interrupted shows them ended.

## Safety

Stop, Pause and Dismiss change no file and run no command. Play and Retry send a message in the Session, so they run
under the Session's access mode, Approvals and Run sandbox like any message.

## UI

Loading, empty and error states follow the tray's. An error from a control shows under its entry.

## Seams

- **Daemon** (`backend/test/agent-sessions.test.ts`, `backend/test/monitor.test.ts`): 1 to 6 and 9.
- **Browser** (`frontend/e2e/session-links.spec.ts`, `workspace.spec.ts`, `monitor-lists.spec.ts`): 1 to 10.

## Out of scope

- A tray entry for background shell tasks.
