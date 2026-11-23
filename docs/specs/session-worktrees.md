# Session worktrees

**Status:** shipped
**Design:** none. The Session header and the Repo rows in the Workspace keep their layout.

## Problem

Every Session in a Repo shared the Repo's one folder. A second Session saw the first one's branch, its pull request and
its changed lines in its own header and Diff button, and the agent worked on code the operator's folder had not
fetched. Commits merged to production never reached a review, a fix or a reply.

## Behavior

1. A new Session in a Repo opens at once in a Session worktree of its own, under the data folder, made from the default
   branch as last fetched. The newest commits follow in the background, and the console fetches the default branch again
   before each run. A worktree made later, when the first one is gone, fetches first. The operator's own folder keeps its
   branch and its changes.
2. A Session on the default branch starts at the newest commit of it, on a detached HEAD, since the Repo's own folder may
   hold the branch. A Session on another branch checks it out, moved forward to origin when it is behind.
3. Sessions on different branches work at the same time. Switching one Session's branch moves its worktree only. A branch
   another Session holds is shared; a branch the Repo's own folder holds starts on a detached HEAD at its commit, as the
   default branch does, and the Session keeps the branch's name.
4. A Session left on the default branch's detached HEAD with no changes starts each run at the newest commit again.
5. The Session's branch is the branch its worktree is on: when the agent makes a branch for its fix, the header shows it,
   and the Session follows it once the run ends. On a detached HEAD the Session keeps the branch it has.
6. The Session panel's Changes row, with its added and removed line counts, and the Diff panel show only when the
   Session's own worktree has changes against where it forked from the default branch, committed or not. A new Session has none, whatever another Session changed or the panel was left open.
7. The header shows the pull request the Session opened, with its branch, for as long as the Session is on that branch.
   A pull request named in the conversation, or found for the default branch, never shows. Without one of its own, the
   Session shows the open pull request of its current branch on the Git host.
8. Opening a pull request, from the button or the agent's `open_pull_request`, and a Fix's PR stage, record the pull
   request on the Session.
9. Deleting a Session removes its worktree and keeps its branch and commits in the Repo.
10. Every run is told to work from the newest production branch, whichever Playbook it follows, and never to run `git
    fetch`, `pull` or `push` itself: the console fetches origin before the run. The built-in Playbooks, the Step blocks'
    skills and the Ops Console skills say so too. A PR action Session fetches the pull request's branch from origin before
    it starts, and the Agent Review brief names its commit and the target branch's.
11. A message in the conversation shows the date and time it ran beside its label.
12. A row in the Workspace's Sessions list gives its Repo name way first when the line is short: the state word and the
    time stay.

## Settled

- **Detached HEAD on the default branch**: git refuses a second worktree on a branch another worktree holds, and the Repo's
  own folder usually holds the default branch. The Session's branch stays the default branch's name.
- **Shared branches**: Sessions on one pull request's branch are a designed flow, so a branch another Session's worktree
  holds is shared (`git worktree add --force`). Two Sessions committing on one branch at once may leave the older worktree
  with stale files; that is the operator's to avoid.
- **Repo folder untouched**: a branch the operator's folder holds is never taken from it. The Session detaches at that
  branch's commit, moved forward to origin when it is behind.
- **PR action Session**: its worktree is detached at the pull request's head commit, on no branch ([pr-actions-open-sessions](pr-actions-open-sessions.md)).
- **A Session made by the backend** (an Alert Session, an Anonymous Session that joined a Repo) gets its worktree at its
  first run. A joined Session starts on the default branch.

## Not required

- **Dependencies in a worktree**: it is a fresh checkout, so `node_modules`, `.env` and other untracked files are not
  there. The agent installs what it needs.

## Safety

The Run sandbox lets a Session's own run write in its worktree and in the Repo's git folder, where its commits go. The
hooks and config of that folder, and the files that point a worktree to it, stay closed ([ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md)).
The agent still never pushes.

## Database

The pull requests the console opened for a Session are rows of `session_pull_requests`, each with the branch it came
from; the Session shows one only while it is on that branch ([session-pull-requests](session-pull-requests.md)).

## API

### `GET /sessions` and `GET /sessions/:id`

`pull_request` is `{ number, url }` for the pull request the Session opened from its current branch, else `null`.

### `GET /sessions/:id/diff`

Reads the Session's worktree. `branch` is the worktree's branch, or the Session's while it is detached. Empty before the
Session has a worktree.

## UI

The Session header shows no pull request found in the conversation. The Changes row and the Diff panel render only with
changed files. Each message shows its date and time beside its label. A Sessions list row truncates the Repo name before
the state word and time.

## Rejected

- **Shared folder, fixed state only**: two Sessions still could not run on different branches at once.
- **Detaching the Repo's own folder**: it would move the operator's folder without asking.

## Glossary

- **Session worktree**: new. **Session**, **Session diff**, **Pull request opening**: changed.

## ADR

- **Agent runs are sandboxed by the OS**: rewritten in place for the Session worktree.
