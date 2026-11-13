# Spawn parallel Sessions

**Status:** shipped
**Design:** none. The batch card follows the Approval panel and the step cards in `design/ops-console.html`; it is new, and no screen there has an equivalent.

## Problem

An operator describes work that touches several Repos. The agent splits it per Repo, but it works in one Session, in one
Repo. It writes the other Repos' tasks to a file and tells the operator to open a Session for each by hand, paste the
task and start it. For four extra Repos that is four New Session dialogs, four pastes and four first runs, one after
another.

## Behavior

1. A chat run the operator started, in an Anonymous Session or a `repo` Session, has a `spawn_sessions` tool. It takes
   a list of entries, each a Repo (name, path or Git URL, matched like `join_repo`) and a task in the agent's words.
2. The tool is not offered in a Playbook step, a Verification, a Fix, a Reply check, a Comment pass, an Agent Review, a
   `pr_review` Session, a dev-tools Session, or a Session that was itself spawned. A spawned Session cannot spawn.
3. The call is checked before it asks. It is refused whole, with the reason, and nothing starts, when: the list is empty;
   an entry's Repo matches no imported Repo; a name matches two Repos (both named, the agent asks which); two entries
   name the same Repo; an entry's task is blank. An entry naming the calling Session's own Repo is refused: that task is
   the Session's own.
4. A valid call asks the operator in every Access mode, `full` included. One Approval lists every Session: Repo name,
   path and the task's first line, each. The operator approves or denies the batch as a whole; there is no per-entry
   choice.
5. A no starts nothing. The agent is told not to ask again, and to say the tasks stay with the operator.
6. A yes creates one `repo` Session per entry, in that Repo, on its default branch, in its own Session worktree made at
   its first run (Session worktrees 1 and 2). Each takes the calling Session's model, effort and Access mode. Its first
   message is the entry's task, as an operator message; the run starts at once. Every child run starts together, with no
   cap and no queue.
7. The first message tells the child it is one of a batch and where the task came from, then: work on a new branch
   (`git switch -c`), commit (hooks run and must pass), and call `open_pull_request` when done. It tells the child the
   other Repos are another Session's work and not to touch them.
8. A child that cannot start (the Repo's folder is gone, the daemon cannot make the worktree) fails on its own run with
   the reason shown in its Session, which stays. The other children are not stopped. The tool's answer to the agent lists each
   child as started or failed to start.
9. The calling run ends with the agent's one line. The calling Session shows a **batch card** under that turn: each child
   with its Repo, state, branch and pull request link, updating live while the children run, and a button that opens it.
   The card survives a reload and a restart: it reads the children from the database.
10. Each child shows "Started from <parent title>" in its header, linking back to the calling Session. The link holds
    after the parent is renamed. Deleting the parent keeps the child and drops the line.
11. A child is a normal Session. It appears in its Repo's group in Workspace, in the Running tray while it runs and on
    the Agent runs page. The operator may stop, pause, retry or delete it alone; none of that touches its siblings or
    the parent.
12. Stopping the parent while its tool call waits for the Approval denies the batch. Stopping it after the children
    started leaves the children running.
13. A child whose run ends unfinished (stopped, out of usage, signed out, a restart) is listed that way on the card and
    in the Running tray, as any run is.
14. Auto-switch, Smart usage and a Disabled account apply to each child's run as to any run: a child never starts on a
    Disabled account.
15. What must not regress: `join_repo` and an Anonymous Session's flow, `open_pull_request` for a single Session, the
    Opened Repo chip, and the Session worktrees of Sessions that were not spawned.

## Settled

- **Who may spawn**: the agent, only through one operator Approval for the whole batch. No operator-only batch from the
  New Session dialog in this change.
- **What a child gets**: the task text, a note that it is one of a batch, and the link to its parent. Not the parent's
  conversation. The agent puts into each task what the child needs; a longer brief goes in the task.
- **Repo-less children**: not offered. Every child is a `repo` Session.
- **No cap**: every child runs at once. Each boots its own Claude Code process with every Connection's MCP server, so a
  large batch slows the whole console. The operator sees the count on the Approval and decides.
- **Access mode of a child**: the parent's. The operator's yes covers the list, and each child then follows its own
  Access mode, Approvals and the Run sandbox like any Session.
- **Parent role**: ends after the call. It does not wait for the children and does not summarise them.
- **Spawn depth**: one. A child holds no `spawn_sessions` tool.
- **Order of children**: the order of the list; none runs before another.
- **Alert Sessions**: a chat in an Alert Session is not offered the tool; its Verification and Fix keep their own flow.

## Not required

- **A cap or a queue**: a batch starts every child. The operator sees it slow if the batch is large.
- **Per-entry approval**: the operator cannot drop one Repo from the batch. A no drops all; the agent may call again
  with a shorter list if the operator says so.
- **Parent summary of the children's results**: the card shows state and pull request links only.
- **Cancel all children from the card**: stop each one from its own row.
- **Sharing a branch or a commit between children**: each works alone; cross-Repo changes that must ship together are the
  operator's to order.
- **The parent reading a child's transcript.**

## Safety

The agent can start Sessions, so it can start runs that open pull requests without a click, one per Repo. That is
the reach one chat run already has per Repo ([ADR 0002](../adr/0002-operator-approves-agent-never-merges.md)): never a
force push, never a merge. What is new is the count, and the one Approval gates it.

- The Approval lists every Repo with the first line of its task and the task's length, in every Access mode, and only a
  yes starts any child.
- The tool is offered only in a run the operator started, never in a job, so text read from logs or a pull request
  cannot reach it. A spawned Session cannot call it, so one yes never grows into more Sessions.
- Each child runs under the Run sandbox ([ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md)) and the Network
  allowlist of its own Repo, with its own Session worktree and output folder. It reads nothing of the parent's.
- Only imported Repos match. A Git URL with no imported Repo is refused; nothing is cloned.
- The Repos' production branches are fetched by the console before each child's first run, as for any Session.
- No new reach for the agent's commands.

## Database

```sql
-- the Session whose agent started this one; null for every other Session
ALTER TABLE sessions ADD COLUMN spawned_by_session_id text REFERENCES sessions(id) ON DELETE SET NULL;
-- the tool-use id of the `spawn_sessions` call that started it, so the batch card lists that call's children only
ALTER TABLE sessions ADD COLUMN spawn_call_id text;
CREATE INDEX sessions_spawned_by_idx ON sessions (spawned_by_session_id);
```

Existing rows keep null. The batch card lists the children whose `spawned_by_session_id` is the calling Session and
whose `spawn_call_id` is the card's call; the tool's answer also carries the child ids for the agent.

## API

### `Session` (changed)

Adds `spawned_by`: `{ id, title }` of the calling Session while it exists, else `null`. Adds `spawned`: the child Sessions as
`{ id, title, call_id, repo_name, branch, state, run_outcome, pull_request }[]`, oldest first, empty when none.

The transcript gets a part `{ kind: "spawn", call_id, entries: [{ repo, task }] }` for each `spawn_sessions` call, read
from the call's input, so the card shows after a reload.

### Console tool `spawn_sessions`

Input:

```json
{ "sessions": [ { "repo": "atlas", "task": "Fix M-12 ..." }, { "repo": "artemis", "task": "..." } ] }
```

Answer to the agent: one line per entry, `started <Repo> as Session <id>` or `failed <Repo>: <reason>`. A refused
call answers `No Sessions were started: <why>` and is an error result.

### WebSocket `session.updated` (unchanged)

Fires for each child as for any Session; the batch card listens to it. No new event.

## UI

- **Approval**: the existing Approval panel, titled "Start N Sessions", listing Repo, path and task first line per
  entry. States: pending, approved, denied. Long lists scroll inside the panel.
- **Batch card** in the calling Session's transcript, under the turn that called the tool. Empty before the answer;
  per row: Repo, state dot (running, idle, failed, waiting for approval), branch, pull request link when one opened,
  and an open button. With no rows it says nothing started: the Approval was denied, or the list was refused. A Session whose run failed to start shows as failed, and its own page says why.
- **Session header** of a child: "Started from <parent title>" beside the Repo and branch.
- Tray and Agent runs page: no change; the children are ordinary runs.

## Rejected

- **Operator-only batch from the New Session dialog**: does not fix the case in the screenshot, where the agent has the
  split and the operator has to retype it.
- **Approving each entry**: one click per Repo gives back most of the time saved.
- **Children share the parent's conversation**: costs tokens in every child and drags in text that is not theirs. The
  task text is the agent's chance to say what matters.
- **Parent stays open and summarises**: holds a run for as long as the slowest child, and the card already shows the
  state and the links.
- **Parent writes the split to a file for the operator** (today): the manual step this change removes.

## Glossary

- **Spawned Session**: new. A Session the agent started in an imported Repo, through one batch Approval, with a task the
  agent wrote. It is a `repo` Session in every other way and cannot spawn.
- **Batch card**: new. What the calling Session's transcript shows for a spawn: each Spawned Session with its state,
  branch and pull request.
- **Session**: changed. Adds that a Session may be spawned by another.
- **Trigger**: no change. A spawn is a tool call in a chat, not a Trigger.

## ADR

- **Operator approves, agent never merges** ([0002](../adr/0002-operator-approves-agent-never-merges.md)): rewritten in
  place. Consequences gain one yes that starts several chat runs, each able to push and open a pull request without
  a click; the no-cap option is recorded under Considered Options as accepted, with its cost.

## Seams

- **Daemon + SQLite** (`backend/test/spawn-parallel-sessions.test.ts`, the Approval through the runtime hook and the
  fake Agent SDK): 1 to 8, 12, 15. Behavior 14 holds through the account choice every run start already makes, which the
  account tests pin.
- **Backend REST** (`GET /sessions/:id`, same file): 9 (data), 10, 11, 13.
- **Browser** (`frontend/e2e/spawn-sessions.spec.ts`, batch card and child header): 9 (card), 10, 13.

## Out of scope

- Operator-made batches from the New Session dialog.
- A cap, a queue or a per-batch limit setting.
- Spawning Anonymous (Repo-less) Sessions, or a deeper chain of spawns.
- Cancel all, retry all and a summary on the batch card.
