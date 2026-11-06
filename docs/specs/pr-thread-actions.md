# PR thread actions

**Status:** shipped
**Design:** Workspace, pull request view (`pull-request-view.tsx`, `pr-thread.tsx`); Claude, Playbooks. Both
buttons are new to the design.

## Problem

A reviewer, or the agent's Agent Review, leaves a comment on a pull request. The author replies "Fixed in 33f8c2b2".
The operator has no way to have the agent check that the reply is true before resolving the thread: the agent only
wakes when the operator types in a thread the agent started, it answers in plain text, and it never resolves. On
their own pull request, the operator must also make every change reviewers asked for by hand: the console has
Review with agent, Approve and Request changes, but nothing that acts on the comments.

## Behavior

### Triggers and built-in Playbooks

1. The Playbooks page lists seven Triggers. Monitor: Verify and Fix. Workspace: Review PR, Check reply, Address
   comments, Reply in thread and Session message.
2. Check reply and Address comments are job Triggers: their Playbook's steps run one turn each, then the console's
   closing turn. Under the steps the editor shows "Check reply: give the verdict and the reply" and "Address
   comments: report each thread done or declined".
3. The built-in Check reply Playbook has four steps: Read the whole discussion, Prepare the code context and Check the
   reply against the code read only; Cross-check dependencies and behaviour is tagged scratch copy.
4. The built-in Address comments Playbook has six steps: Read the selected threads, Prepare the code context, Weigh
   each comment and decide and Validate each thread and review the diff read only; Implement the agreed changes and
   Run the tests are tagged scratch copy.
5. Check reply and Address comments take a Playbook with steps tagged "scratch copy", as do Verify, Fix and Review PR.

### Check reply

6. Check replies shows at the top of an open pull request, before Address comments, with the number of threads it
   will check: every unresolved thread with at least one reply whose last comment is not the agent's, on a line, a
   file or the pull request. It does not show when there are none, or on a merged or closed pull request. Threads
   have no Check reply button of their own.
7. Pressing it starts one Reply check over all of those threads, a Comment pass of kind `check`. It copies the Check
   reply Playbook, makes one scratch copy at the pull request's head commit, and runs the steps once in the pull
   request's Session. The Comment pass card, titled Check replies, shows the Playbook's name, each step's status
   and summary, and the threads.
8. The closing turn returns a verdict (fixed, partly fixed or not fixed) and a short reply for every thread. The
   console posts each reply in its thread as the agent and resolves each fixed thread on a line or a file. Partly
   fixed and not fixed threads stay open. It changes, commits and pushes nothing.
9. Once its replies are posted, a thread's last comment is the agent's, so the next Check replies skips it until
   someone replies again.
10. A failed step, or a closing answer the console cannot read, fails the pass and posts nothing. The card shows the
    failed step's summary and "Retry from step N", which runs in the kept scratch copy.
11. Replies or resolves that fail after the verdicts fail the pass and list the threads left without them. Retry
    posts and resolves only those.

### Address comments

12. Address comments shows next to Review with agent on any open pull request, the operator's or someone else's,
    that has at least one unresolved thread: on a line, on a file, or a general comment on the pull request. It does
    not show on a merged or closed pull request, or one with every thread resolved.
13. Pressing it opens a list of every unresolved thread: file and line, or "General comment", then the first
    comment's author and its first line. All are ticked. Start needs at least one ticked; Cancel closes the list and starts nothing.
14. Start begins a Comment pass over the ticked threads: it copies the Address comments Playbook, makes a scratch
    copy at the pull request's head commit, and runs the steps once over all of them in the pull request's Session.
    A card in the pull request view shows the Playbook's name, each step's status and summary, and the threads.
15. The closing turn returns each ticked thread as done or declined, each with a reply. A declined thread carries the
    agent's reason: it disagrees, or the comment is unclear.
16. The console commits every change in the scratch copy as one commit, `Address review comments on #<n>` followed by
    one line per done thread, `- <file>:<line>`, or `- <author>'s comment on the pull request` for a general comment,
    and pushes it to the pull request's branch without force. The
    commit skips the Repo's git hooks: the scratch copy has no installed packages for them, and the host's CI still
    checks the push.
17. After the push the console posts each reply in its thread as the agent; a done reply names the short commit
    sha. It resolves each done thread on a line or a file. A general comment gets its reply and stays open: the hosts
    have no thread to resolve there. Declined threads stay open.
18. A Comment pass that changed no file, or declined every thread, makes no commit and no push, posts the replies
    and finishes ready.
19. A push the host refuses because the branch moved is not a failure: the console fetches the new tip, rebases its
    commit onto it and pushes again, never with force, up to three times. Only a rebase that conflicts with the new
    commits fails the Comment pass, with "The branch moved; run Address comments again."; the rebase is undone,
    nothing is posted and Retry is not offered. The reply names the sha that was pushed, after the rebase.
20. A failed step, or a closing answer the console cannot read, fails the Comment pass with nothing pushed or posted.
    The card shows "Retry from step N", which runs in the kept scratch copy.
21. A push that worked but replies or resolves that failed fail the Comment pass and list the threads left without
    a reply or resolve. Retry posts and resolves only those, with no new push.
22. The card shows the commit's short sha and each thread with done or declined and its reply. The newest Comment
    pass shows open and older ones fold; each is marked "older commit" once the pull request's head moves past the
    commit it started from.

### Both

23. One job runs on a pull request at a time. While an Agent Review, a Reply check or a Comment pass runs, Review with
    agent, every Check reply and Address comments are disabled with "The agent is working on this PR", and the API
    answers 409 `session_busy`.
24. Both jobs run in the pull request's Session with its Access mode. Edits and commands in the scratch copy follow
    that mode, and a PROD write still asks.
25. A job's scratch copy is removed when the job finishes ready, and kept when it fails so Retry can use it. A new
    Reply check on the same thread, or a new Comment pass on the same pull request, removes the failed one's copy.
    At start-up the console removes every copy except those of failed jobs. The removal runs after the port opens, so a
    large copy never delays start-up.
26. A scratch copy that cannot be made (the head commit cannot be fetched) fails the job before step 1 with "Could
    not make a scratch copy:" and git's message.
27. A Git host that is down or rate limited when the operator presses a button starts no job, and the button shows
    the host's error.
28. A reload mid-run brings back the strip and the card with each step's status, and they keep updating live.
29. A daemon restart mid-step fails the step and its job as interrupted, as for every Playbook job.
30. While a Reply check or a Comment pass runs, its strip or card shows Stop. Stop ends the agent's turn in the pull
    request's Session. The job fails with "stopped by the operator", nothing is pushed or posted, and Retry runs the
    stopped step again. A stop during the push or the replies is refused, since no agent turn runs then.
31. Nothing else changes: the operator's own reply in a thread the agent started still wakes the agent through Reply
    in thread, Agent Review runs as before, and Resolve and Unresolve work as before. While a job runs on the pull
    request, that answer waits for the job to end.

## Settled

- **Reply check and Comment pass**: the jobs Check reply and Address comments start. Not "Fix", which is an Alert's.
- **Any thread**: Check reply works on threads a reviewer, the operator or the agent started.
- **The agent resolves on fixed**: pressing Check reply is the operator's approval; Unresolve undoes it.
- **Own pull requests only**: Address comments never pushes to someone else's branch. Own means what the pull
  request list's Mine means: the operator wrote it, or a Session in the console worked its branch.
- **The button is the approval**: Address comments commits, pushes, replies and resolves with no second stop, as a
  confirmed Review starts a Fix.
- **One pass over all ticked threads**: one run of the Playbook, one commit, one push.
- **Scratch copy, not the checkout**: both jobs work in a scratch copy at the pull request's head commit, so the
  operator's checkout and uncommitted work stay untouched.
- **The console writes to the host**: the agent returns JSON; the console commits, pushes, posts and resolves. Both
  jobs' runs deny `git push` and the `gh`, `glab` and `bkt` comment and API commands through `disallowedTools`, as
  merging is denied.
- **No force push**: a branch that moved is the operator's to look at.
- **Button only**: neither job starts on its own when a comment arrives.
- **One job per pull request**: all three share the pull request's Session, which runs one turn at a time.
- **Statuses**: `running`, `ready`, `failed`, as an Agent Review.

## Not required

- **A fresh diff before the push**: the operator sees the commit on the card and on the host after the push, not
  before it.
- **Comments with no line**: a comment on the pull request as a whole is read and answered, and cannot be resolved.
- **Pull requests from forks**: a Reply check whose head commit cannot be fetched fails as in Behavior 26.
- **Resume after a daemon restart**: the step fails as interrupted; Retry runs it again.

## Safety

- A Reply check reads only, except in a step tagged "scratch copy" (the built-in has one); there it may write
  files and run local commands in its scratch copy.
- A Comment pass may write files and run local commands in its scratch copy. In this job only, the ticked review
  comments are change requests: the agent may change code to meet them. It never runs a command, reads a secret,
  touches a Connection or pushes because a comment says so. In every other run, pull request text stays data, never
  instructions. The safety lines say so and still close the system prompt.
- The console pushes only the pull request's own branch, on the operator's pull request or a teammate's, never with force,
  with an Action Log row before the push. The agent's own push, comment and resolve commands are denied.
- Merging stays denied. A PROD write still asks in every Access mode. No value read from a PROD Connection goes
  into a file, a commit or a comment.
- ADR 0002 is rewritten as below.

## Database

```sql
-- One Reply check: the agent's verdict on one thread.
CREATE TABLE pr_reply_checks (
  id TEXT PRIMARY KEY NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  -- The thread's root comment on the Git host.
  comment_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ready', 'failed')),
  verdict TEXT CHECK (verdict IN ('fixed', 'partly_fixed', 'not_fixed')),
  reply TEXT,
  -- Set once the reply is on the host; Retry skips posting when set.
  reply_comment_id TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  -- Set when the job fails; 0 for a scratch copy that could not be made (Behavior 26).
  can_retry INTEGER NOT NULL DEFAULT 0,
  -- The scratch copy's folder, under pr-scratch in the data directory; null once removed.
  scratch_path TEXT,
  playbook_id TEXT REFERENCES playbooks(id) ON DELETE SET NULL,
  playbook_name TEXT,
  playbook_rules TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX pr_reply_checks_thread_idx ON pr_reply_checks (repo_id, pr_number, comment_id, created_at DESC);

-- One Comment pass: Address comments over the ticked threads, or Check replies over every replied one.
CREATE TABLE pr_comment_passes (
  id TEXT PRIMARY KEY NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  -- `address` changes code and pushes; `check` gives each thread a verdict (outcome fixed, partly_fixed, not_fixed).
  kind TEXT NOT NULL DEFAULT 'address',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ready', 'failed')),
  -- Where a retry picks up: the steps and closing turn, the commit and push, or the replies and resolves.
  stage TEXT NOT NULL DEFAULT 'steps' CHECK (stage IN ('steps', 'push', 'post')),
  -- Null until pushed, and when there was nothing to commit.
  commit_sha TEXT,
  -- [{ "comment_id", "file_path", "line", "author", "excerpt",
  --    "outcome": "pending | done | declined", "reply": "string | null",
  --    "reply_comment_id": "string | null", "resolved": false }]
  threads TEXT NOT NULL,
  error TEXT,
  -- Set when the job fails; 0 when the branch moved (Behavior 19) or no scratch copy could be made.
  can_retry INTEGER NOT NULL DEFAULT 0,
  scratch_path TEXT,
  playbook_id TEXT REFERENCES playbooks(id) ON DELETE SET NULL,
  playbook_name TEXT,
  playbook_rules TEXT,
  created_at TEXT NOT NULL,
  CHECK (json_valid(threads))
);
CREATE INDEX pr_comment_passes_pr_idx ON pr_comment_passes (repo_id, pr_number, created_at DESC);

-- Rebuilt: two more Triggers.
-- playbook_triggers.trigger CHECK (trigger IN ('verify', 'fix', 'review_pr', 'check_reply', 'address_comments',
--   'thread_reply', 'session_message'))

-- Rebuilt: two more job columns; exactly one job column is set.
ALTER TABLE playbook_steps ADD COLUMN reply_check_id TEXT REFERENCES pr_reply_checks(id) ON DELETE CASCADE;
ALTER TABLE playbook_steps ADD COLUMN comment_pass_id TEXT REFERENCES pr_comment_passes(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX playbook_steps_reply_check_idx ON playbook_steps (reply_check_id, position)
  WHERE reply_check_id IS NOT NULL;
CREATE UNIQUE INDEX playbook_steps_comment_pass_idx ON playbook_steps (comment_pass_id, position)
  WHERE comment_pass_id IS NOT NULL;
-- CHECK ((report_id IS NOT NULL) + (fix_id IS NOT NULL) + (agent_review_id IS NOT NULL)
--   + (reply_check_id IS NOT NULL) + (comment_pass_id IS NOT NULL) = 1)
```

Migration: new tables start empty. `playbook_triggers` and `playbook_steps` are rebuilt to widen their CHECKs; their
rows copy over unchanged.

## API

### Common

`ReplyCheck`:

```json
{
  "id": "uuid",
  "repo_id": "uuid",
  "pr_number": 12,
  "comment_id": "string",
  "head_sha": "string",
  "status": "running | ready | failed",
  "verdict": "fixed | partly_fixed | not_fixed | null",
  "reply": "string | null",
  "resolved": false,
  "error": "string | null",
  "can_retry": false,
  "created_at": "ISO 8601",
  "playbook": JobPlaybook
}
```

`CommentPass`:

```json
{
  "id": "uuid",
  "repo_id": "uuid",
  "pr_number": 12,
  "kind": "address | check",
  "head_sha": "string",
  "status": "running | ready | failed",
  "commit_sha": "string | null",
  "threads": [
    {
      "comment_id": "string",
      "file_path": "string | null",
      "line": 42,
      "author": "string",
      "excerpt": "string",
      "outcome": "pending | done | declined | fixed | partly_fixed | not_fixed",
      "reply": "string | null",
      "posted": false,
      "resolved": false
    }
  ],
  "error": "string | null",
  "can_retry": false,
  "stale": false,
  "created_at": "ISO 8601",
  "playbook": JobPlaybook
}
```

- `can_retry`: failed, and neither a moved branch (Behavior 19) nor a scratch copy that could not be made
  (Behavior 26).
- `stale`: the pull request's head is no longer `head_sha` or `commit_sha`.
- `JobPlaybook`: as in the Playbooks spec.

`PullRequestDetail` gains `reply_checks` (the newest per thread) and `comment_passes` (newest first).

| Status | Error code          | When                                                                                       |
| ------ | ------------------- | ------------------------------------------------------------------------------------------ |
| 400    | `validation_failed` | No thread ticked, or a ticked comment that is not the start of an unresolved thread        |
| 404    | `not_found`         | No such pull request, thread or job                                                        |
| 409    | `session_busy`      | A job is running on this pull request                                                      |
| 409    | `invalid_state`     | Pull request merged or closed; Address comments on someone else's; Check reply on a resolved thread or one whose last comment is the agent's; a retry of a job that cannot retry |
| 429    | `rate_limited`      | The Git host says to slow down                                                             |
| 502    | `upstream_failed`   | The Git host is down or refused                                                            |

### `POST /repos/:repo/pull-requests/:number/reply-checks`

Body: `{ "comment_id": "string" }`, the thread's root. 202 `ReplyCheck` in `running`.

### `POST /reply-checks/:id/retry`

202 `ReplyCheck` in `running`. From the failed step, or only the post or resolve left undone (Behavior 11).

### `POST /repos/:repo/pull-requests/:number/reply-check-passes`

No body. 202 `CommentPass` of kind `check` in `running`: Check replies over every unresolved thread with a reply
(Behavior 7).

### `POST /repos/:repo/pull-requests/:number/comment-passes`

Body: `{ "comment_ids": ["string"] }`, at least one. 202 `CommentPass` in `running`.

### `POST /comment-passes/:id/retry`

202 `CommentPass` in `running`. From the failed step, or only the posts and resolves left undone (Behavior 21).

### `GET /playbooks`, `PUT /playbook-triggers/:trigger`

`triggers` and `:trigger` accept `check_reply` and `address_comments`.

### WebSocket `pull_request.job_changed`

Server to client, each time a Reply check or Comment pass changes status, posts or resolves.

```json
{ "repo_id": "uuid", "number": 12, "kind": "reply_check | comment_pass", "id": "uuid", "status": "running | ready | failed" }
```

### WebSocket `playbook_step.updated`

Gains `reply_check_id` and `comment_pass_id`, null unless the step is that job's.

## UI

- **Thread** (`pr-thread`): has no Check reply button (Behavior 6). While a Reply check runs, a strip
  under the last comment shows "Checking the reply" with the Playbook's name and each step with its status; failed
  reads "Reply check failed" with the error, "Retry from step N" and "Skip step N", or Retry when no step failed. Stop shows
  while it runs (Behavior 30). Disabled while another job runs on the pull
  request, with the title "The agent is working on this PR".
- **Pull request header**: Address comments next to Review with agent when Behavior 12 holds, with the same
  disabled state. It opens the thread list (Behavior 13) with Start and Cancel.
- **Comment pass card**: under the Agent Review card. Header "Comment pass" with the Playbook's name as a pill, as on
  the Agent Review card, then the status, the commit's
  short sha linked to the host, "older commit" when stale. Then the steps, then each thread: `file:line`, author,
  done or declined, and the reply. Stop shows while it runs, as on the Agent Review card. Failed shows the error
  and Retry when it can retry, and "Skip step N" after a failed step. A failure in the push or the replies leaves
  the closing turn done, since every thread has its answer. Older passes fold under
  the newest.
- **Error**: a refused start shows the host's or the API's message under the button.
- **Playbooks page**: Check reply and Address comments in the Workspace group after Review PR, each with its
  built-in. Their closing turns under the steps (Behavior 2).
- **PROD**: no change.

## Rejected

- **Agent resolves only after the operator confirms the verdict**: one more click per thread for a step Unresolve
  already undoes.
- **Writing in the operator's checkout, as a Fix does**: stashing and switching branches would get in the way of
  work in progress on that Repo.
- **Show the diff and wait before the push**: the operator already chose the threads; the commit is on the card and
  on the host to look at after.
- **One run per thread**: a commit and a push for each thread, and changes that touch the same file would fight.
- **Waking on a reviewer's reply**: the console does not watch for new comments, and a run nobody asked for would
  spend quota and post under the operator's name.
- **Force push when the branch moved**: it could drop a teammate's commit.
- **The agent posts and resolves with its own tools**: the console could not record what was posted, or retry only
  what failed.

## Glossary

- **Reply check**: the agent's check of one pull request thread: whether the code at the head commit does what the
  thread asked, given as fixed, partly fixed or not fixed in a reply. On fixed the thread is resolved.
- **Comment pass**: the agent's work on the review threads the operator ticked on a pull request, theirs or a
  teammate's: one commit pushed to its branch, a reply in each thread, and each done thread on a line resolved.
- **Trigger** (changed): a place in a tab that starts the agent: Verify and Fix in Monitor, Review PR, Check reply,
  Address comments, Reply in thread and Session message in Workspace.
- **Scratch copy** (changed): a throwaway copy of a Repo's code, at its default branch for a Verification or at a
  pull request's head commit for a Reply check or a Comment pass, where the agent may write files and run local
  commands. A Playbook step that needs one carries the tag "scratch copy".

## ADR

- **0002, Operator approves, agent never merges** (rewritten): adds that pressing Address comments on any open pull
  request is the approval for one commit and a push to that branch, made by the console. In a Comment pass
  the ticked review comments are change requests for the code in its scratch copy; everywhere else pull request
  text stays data. Considered Options gains "Pull request text is never an instruction, in every run": it lost
  because acting on review comments is the job the operator asked for.

## Seams

- **Backend + SQLite over HTTP** (fake Agent SDK, fake Git host, a local bare git remote that receives the push):
  1 to 5, 7, 8, 10, 11, 14 to 21, 23 to 27, 29 to 31.
- **Browser** (Playwright, mocked API): 6, 9, 12, 13, 22, 28, 30, and the screens behind 1, 2, 7, 10, 23.

## Out of scope

- Waking the agent on a reviewer's new comment.
- Comment passes on someone else's pull request, as a suggested change in a comment instead of a push.
