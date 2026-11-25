# One Session per pull request

**Status:** shipped
**Design:** `design/workspace-pr-bitbucket.html`, frame 2 (the Sessions section of the rail, the greyed New Session). Departure from `design/ops-console-sidebar.html`: the rail lists one PR Session, not one per press.

## Problem

Every press of Address comments, Check replies or Agent Review opens a new PR action Session. A pull request that goes through two review rounds ends up with five or six Sessions. Each starts cold, so the agent forgets what it decided last round, and the Sessions list and the rail grow without end. New Session on the rail adds one more even when a Session on the branch is alive.

## Behavior

### The PR Session

1. A pull request has at most one PR Session: a `repo` Session of its Repo in a detached worktree at the head commit. The first press of Address comments, Check replies or Agent Review makes it. Every later press of any of the three posts its opening prompt into the same Session, and the conversation so far stays.
2. The Session is titled "Pull request #<n>". It holds one Round at a time: the action of the latest press, its threads and its head commit.
3. A press while the Session's turn is running is refused: the three buttons are disabled with "The Session is working on this pull request", and the API answers 409 `session_busy`. A press while the Session is idle starts a new Round, even when the last Round never submitted. The unsubmitted Round is dropped.
4. Before a Round starts, the console fetches the branch and moves the worktree to the pull request's current head commit. Uncommitted changes in the worktree travel along. When git cannot do that, nothing starts and the button shows "Could not move the worktree to the head commit:" and git's message.
5. Deleting the PR Session removes its worktree as for any Session. The next press makes a fresh one.
6. A Session that exists from before this change stays as it is. The newest PR action Session of a pull request becomes its PR Session; the older ones stay in the list and are never reused.

### Rounds

7. Each Round ends in its own submit call: `submit_thread_results` for Address comments, `submit_reply_verdicts` for Check replies, `submit_review` for Agent Review. All three tools are offered in the PR Session. A call that does not match the current Round returns "This Round is <action>" and posts nothing. A second call in the same Round answers "Already submitted".
8. The rail shows the PR Session with its state, and under it the current Round: its action and working, not submitted or submitted. The commit the Round pushed shows as a short hash, as today. A Round on an older head commit than the pull request's says `older commit`.
9. Every Behavior of "PR actions open Sessions" about posting, the commit, the push, rebase, replies and resolves holds per Round.

### A thread's own buttons

10. Check reply and Address comment on a thread start a Round for that one thread. Check reply works when the thread has a reply whose last comment is not the agent's. Address comment works on an unresolved thread. Both go to the PR Session.
11. The rail's Address comments and Check replies work as before, on all open threads.

### New Session

12. New Session on the rail is disabled with "A Session is already linked to this pull request" while the PR Session, or any of the operator's own Sessions on the branch, exists. Deleting the last of them enables it. A merged or closed pull request shows no New Session.

### Monitor

13. An Alert already keeps one Session for its Verification and Fix, made on first use. It stays so: Verify, Verify again and Fix all run in it. Deleting the Session leaves the Alert with none, and the next Verify or Fix makes a new one. The Alert's page links to the live Session and never offers a button that starts another.

## Settled

- **One per pull request, all three kinds**: the follow-up knowledge is the point, so Address comments, Check replies and Agent Review share it.
- **Dropped Round**: a press on an idle Session replaces an unsubmitted Round instead of refusing. The agent's chat keeps what was said.
- **Own Sessions are never reused**: the buttons post into the PR Session only. It loads no project settings or hooks from the pull request's code and has no browser tools; the operator's own Session does.
- **No unique index**: the old partial index on open PR actions goes. A per-PR lock in the daemon holds start-up of the one Session.

## Not required

- **Round history in the UI**: the rail shows the current Round only. The transcript holds the rest.
- **Reusing a legacy Session older than the newest**: they stay as history.

## Safety

The ADR 0002 rules hold in every Round: the agent never pushes, comments, resolves or merges; the console's tool call does, as the operator, without force. Posting happens only when the operator pressed a button for that Round. A thread's own button counts as that press. In an Address comments Round only, the ticked threads are change requests; in every other Round, and in chat turns between Rounds, pull request text is data.

## Database

```sql
-- The old rule held one open Session per pull request and action.
DROP INDEX sessions_one_open_pr_action_idx;
-- Lookup of a pull request's PR Session.
CREATE INDEX sessions_pr_session_idx ON sessions (repo_id, pr_number) WHERE pr_action IS NOT NULL;
```

`pr_action`, `pr_action_head_sha`, `pr_action_threads`, `pr_action_commit_sha` and `pr_action_submitted_at` now describe the current Round and are overwritten when a Round starts. No rows change at the update.

## API

### `POST /repos/:id/pull-requests/:number/actions`

Changes only what it adds. `comment_ids` is now also accepted for `check_replies`, to check some threads and not all. It still needs at least one id for `address_comments`, and is refused for `review`. The response is the PR Session, new or reused.

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `session_busy` | the PR Session's turn is running |
| 502 | `upstream_failed` | the branch cannot be fetched, or the worktree cannot move to the head commit |

`GET` of a pull request returns `action_sessions` with at most one PR Session plus legacy ones, each with its current Round's `action`, `state`, `commit_sha` and `stale`.

## UI

Rail, Sessions section: the PR Session row with its Round line, then the operator's own Sessions on the branch, then New Session, greyed with its reason as a tooltip while any is alive. Errors show under the button as today.

## Rejected

- **One Session per button kind**: three Sessions per pull request, and what the agent learned in Address comments is lost to Check replies.
- **Posting into the operator's own Session on the branch**: that Session loads the code's settings and hooks, which a PR action Session must not.
- **Keep one Session per press and only grey New Session**: leaves the growth and the lost context.

## Glossary

- **PR Session**: the one Session of a pull request, in a detached worktree at its head commit, where Address comments, Check replies, Agent Review and a thread's own buttons run, one Round after another, until the operator deletes it. Replaces PR action Session.
- **Round**: one press of those buttons inside the PR Session: its action, threads and head commit, ending in one submit call.

## ADR

- **0002, rewritten in place**: pressing a button approves one Round, not one Session, and the Round ends in one tool call. The Session outlives its Rounds. The old design joins Considered Options: one Session per press lost because each round started without the last one's knowledge and the Sessions list grew with every press.

## Seams

- **Backend + SQLite** (`backend/test/pr-actions.test.ts`): 1 to 11, with a fake Git host and a real origin: second press reuses the Session, busy refusal, Round replaced when idle, worktree moved to a new head, deleted Session makes a fresh one, tool call of another Round refused, per-thread buttons.
- **Backend** (`backend/test/monitor-sessions.test.ts`): 13.
- **Frontend component** (`frontend/src/workspace/pr-sessions.test.tsx`): 8, 12.

## Out of scope

- A Round history list on the rail.
