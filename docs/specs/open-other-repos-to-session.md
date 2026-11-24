# Open other Repos to a Session

**Status:** shipped
**Design:** none. The composer's Repos icon sits beside Attach.

## Problem

A chat in one Repo often finds the fix in another: a log in `apis` points at a change in `admin-panel`. A checkout
outside the Session's working folder is none of the run's folders: the agent is not told it exists, and `run_integration` refuses it as a file argument. The operator wants the agent to work in the other Repo as in
its own.

## Behavior

1. The composer shows a Repos icon beside Attach. Its tooltip reads "Repos: this one" until the operator opens another,
   then lists them ("Repos: this one, admin-panel"), and the icon carries the count. It is hidden when the console has
   no other Repo.
2. The icon opens a list of the other imported Repos, A to Z, with a search box. It does not list the Session's own Repo.
   The operator ticks and unticks Repos; each click saves.
3. From the Session's next run, the operator's own runs in that Session (a chat turn) work in each ticked checkout (an
   Opened Repo) as in the working folder. The run adds it as an additional folder, `git` checkout, branch, add and commit run there, and
   `run_integration` accepts files in it as arguments.
4. A ticked Repo's git control files (`.git/hooks`, `.git/config` and the rest the working folder closes) stay closed.
   The agent never pushes and `open_pull_request` opens a pull request for the working folder's branch only.
5. A Playbook step, a Verification, a Fix, an Agent Review and every read-only run get no extra Repo.
6. The agent is told which checkouts are open. It cannot open one: the choice is the operator's click on an imported
   Repo, never a path in a message or a tool call.
7. A Repo removed from the console drops out of the next run. A Session never lists its own Repo, and the same Repo is
   kept once.
8. Everything else about the Run sandbox is unchanged ([ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md)): the
   Keychain folder and the installed app stay unreadable, and the Access mode still decides which commands ask.

## Settled

- **Per Session, by click**: a global list of Repos, or a path typed in a message, would let a run steered by log text
  take in a folder the operator never chose ([ADR 0002](../adr/0002-operator-approves-agent-never-merges.md),
  [ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md)).
- **No separate Setting**: the sandbox still has no off switch.
