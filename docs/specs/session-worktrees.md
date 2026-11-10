# Session worktrees

**Status:** shipped
**Design:** none. The Session header and the Repo rows in the Workspace keep their layout.

## Problem

Every Session in a Repo shared the Repo's one folder. A second Session saw the first one's branch, its pull request and
its changed lines in its own header and Diff button, and the agent worked on code the operator's folder had not
fetched. Commits merged to production never reached a review, a fix or a reply.

## Behavior

1. A new Session in a Repo fetches the Repo's default branch from origin first, then works in a Session worktree of its
   own, under the data folder. The operator's own folder keeps its branch and its changes.
2. A Session on the default branch starts at the newest commit of it, on a detached HEAD, since the Repo's own folder may
   hold the branch. A Session on another branch checks it out, moved forward to origin when it is behind.
3. Sessions on different branches work at the same time. Switching one Session's branch moves its worktree only. A branch
   another Session holds is shared; a branch the Repo's own folder holds is refused, naming the folder.
4. A Session left on the default branch's detached HEAD with no changes starts each run at the newest commit again.
5. The Session's branch is the branch its worktree is on: when the agent makes a branch for its fix, the header shows it,
   and the Session follows it once the run ends. On a detached HEAD the Session keeps the branch it has.
6. The Diff button shows only when the Session's own worktree has changes against where it forked from the default
   branch, committed or not. A new Session has none, whatever another Session changed or the panel was left open.
7. The header shows the pull request the Session opened, with its branch, for as long as the Session is on that branch.
   A pull request named in the conversation, or found for the default branch, never shows. Without one of its own, the
   Session shows the open pull request of its current branch on the Git host.
8. Opening a pull request, from the button or the agent's `open_pull_request`, and a Fix's PR stage, record the pull
   request on the Session.
9. Deleting a Session removes its worktree and keeps its branch and commits in the Repo.
10. Every run is told to fetch origin and work from the newest production branch, whichever Playbook it follows: the
    built-in Playbooks, the Step blocks' skills and the Ops Console skills say so too. A Reply check, a Comment pass and
    an Agent Review fetch the production branch before they start, and the Agent Review brief names its commit.
11. A user message in the conversation shows the date and time it ran.
12. A Repo row in the Workspace's Sessions list keeps its running count, Session count and New Session button apart: a
    long Repo name gives way first.

## Settled

- **Detached HEAD on the default branch**: git refuses a second worktree on a branch another worktree holds, and the Repo's
  own folder usually holds the default branch. The Session's branch stays the default branch's name.
- **Shared branches**: Sessions on one pull request's branch are a designed flow, so a branch another Session's worktree
  holds is shared (`git worktree add --force`). Two Sessions committing on one branch at once may leave the older worktree
  with stale files; that is the operator's to avoid.
- **Repo folder untouched**: a branch the operator's folder holds is refused instead of detaching that folder.
- **A Session made by the backend** (an Alert Session, an Anonymous Session that joined a Repo) gets its worktree at its
  first run. A joined Session starts on the default branch.

## Not required

- **Dependencies in a worktree**: it is a fresh checkout, so `node_modules`, `.env` and other untracked files are not
  there. The agent installs what it needs.
- **Old Sessions on the branch the Repo's folder holds**: they fail their next run with the folder's name until it moves.

## Safety

The Run sandbox lets a Session's own run write in its worktree and in the Repo's git folder, where its commits go. The
hooks and config of that folder, and the files that point a worktree to it, stay closed ([ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md)).
A run in a scratch copy gets no git folder. The agent still never pushes.

## Database

```sql
ALTER TABLE sessions ADD COLUMN opened_pr_number integer;
ALTER TABLE sessions ADD COLUMN opened_pr_url text;
-- the branch the pull request came from; the Session shows it only while it is on that branch
ALTER TABLE sessions ADD COLUMN opened_pr_branch text;
```

Existing rows keep null: they show the open pull request of their branch until they open one.

## API

### `GET /sessions` and `GET /sessions/:id`

Adds `pull_request`: `{ number, url }` for the pull request the Session opened from its current branch, else `null`.

### `GET /sessions/:id/diff`

Reads the Session's worktree. `branch` is the worktree's branch, or the Session's while it is detached. Empty before the
Session has a worktree.

## UI

The Session header drops the pull request found in the conversation. The Diff button and panel render only with changed
files. Each message shows its date and time beside its label. The Repo row truncates the name before the counts.

## Rejected

- **Shared folder, fixed state only**: two Sessions still could not run on different branches at once.
- **Detaching the Repo's own folder**: it would move the operator's folder without asking.

## Glossary

- **Session worktree**: new. **Session**, **Session diff**, **Pull request opening**: changed.

## ADR

- **Agent runs are sandboxed by the OS**: rewritten in place for the Session worktree.
