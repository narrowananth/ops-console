# Session panel and subagent wait

**Status:** shipped
**Design:** `design/ops-console-t3-shell.html`. The Session panel, the waiting row and the Lineage list follow it. The thread sidebar, the Files, Device and Side chat surfaces and the composer footer in that mockup are not built.

## Problem

The agent splits work across subagents, but the operator sees only a count in the Running tray. In the Session itself nothing says the run is waiting on them, what they are, or how long they have run. The branch, pull request, changes, servers and the Sessions around this one sit behind separate buttons.

## Behavior

1. While a Session's run has a subagent working, a row above the composer reads "Waiting on N subagents" with their descriptions, and a Stop button. Hovering or focusing the row lists each working subagent with the time it has run.
2. Stop on the row stops the run, as the composer's Stop does. Every subagent of the run ends with it.
3. The row shows only for working subagents. A finished one is not counted; with none working the row is gone.
4. The Session header has a Session button. It opens the Session panel in the right column and folds the Browser or Diff panel, as they fold each other. A dot on the button says a subagent is working.
5. The panel lists the surfaces to open (Browser and Terminal in a Session with a folder, Diff when the branch changed, Pull request when there is one), the branch and its pull request, Changes with the added and removed lines, and Servers: the listeners of this Session's processes. A server row opens it in the Browser.
6. Under Lineage the panel lists the Session that started this one, the Sessions this one started, and the subagents of its latest run, working first. Each subagent shows its description, type, state and how long it ran.
7. The Session carries `subagents`: the latest run's subagents, kept after the run ends and updated live as they start and finish. A Session that never ran one has an empty list.
8. A run is told to start one subagent per independent part with the Agent tool, in one turn, with a brief of its own and its own files, and to give the operator one merged answer. It is told not to start one for work it can finish in a few steps.
9. The panel opens by default and holds the actions on the Session, so the header keeps only the title and state. Open in VS Code and a folder button open the Session's worktree on this machine. Run a script opens the Terminals dock. The branch chip switches branch. The pull request shows its title and CI state.
10. Commit, push & PR is one split button. The row does the next step: Commit while files are uncommitted, then Create PR when the branch can open one, else Push. Its menu lists all three. Commit asks for a message, writes one from the file names when it is blank, and can commit on a new branch (`ops/<words>`) that the Session then follows. Push never forces and rebases onto a moved branch, as opening a pull request does.
11. Must not regress: the Running tray's subagent nesting, the Agent runs page, the Browser and Diff panels, and a Session with no subagent.

## Settled

- **Merging**: the main agent merges its subagents' results in its own answer. The console does not build a second summary.
- **Waiting row**: shown for working subagents only, so a finished fan-out leaves no row.
- **Panel width**: the Session panel shares the Diff panel's width and resize handle.

## Not required

- **Per-subagent Stop**: Stop ends the whole run.
- **Subagent transcripts in the panel**: the row and the list show state and time, not what a subagent said.
- **Subagents of older runs**: the list holds the latest run's.

## Safety

No change. Subagents run under the Session's Access mode and Run sandbox like the main agent.

## Database

None. The list reads the existing `sessions.run_subagents` column.

## API

`POST /sessions/:id/commit` `{ message?, new_branch }`, `POST /sessions/:id/push`, `POST /sessions/:id/open-folder` `{ target: editor | folder }`. The daemon opens only the Session's own worktree, with a fixed program and no shell (ADR 0003). A commit skips the Repo's git hooks, as every scratch copy does.

`GET /sessions` and `GET /sessions/:id` add `subagents`: `{ id, parent_id, description, type, status, started_at, finished_at }[]`.
`session.updated` carries it.
