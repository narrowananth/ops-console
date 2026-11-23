# PR actions open Sessions

**Status:** shipped
**Design:** Workspace, pull request view in `design/ops-console-sidebar.html` (the Threads rail and the Sessions rail). Departure: the design shows a Comment pass card, a Reply check strip and an Agent Review card. This change removes all three; each action instead appears as a Session in the Sessions rail.

## Problem

Address comments, Check replies and Review with agent run as jobs: the Playbook's steps run one turn each in a scratch copy, the agent gives one JSON answer, and the console posts it. The operator cannot talk to the agent while it works. They cannot ask why it declined a thread, add a request, or point it at a different file. A failed step offers only Retry from step N. The agent runs in a scratch copy with no installed packages, so a build or test it needs often fails there.

A normal Session has none of these limits. The operator wants the three buttons to start a Session instead.

## Behavior

### Triggers and Playbooks

1. The Playbooks page still lists seven Triggers. Verify and Fix stay job Triggers. Review PR, Check reply and Address comments become Session Triggers: the Playbook's rules, skills and steps go into the Session's opening prompt, and the agent runs them in one turn. The editor shows no closing-turn caption and no "scratch copy" tag for these three. A `writes` tag already stored on their steps is ignored.
2. A built-in Playbook for these three reads as instructions to the agent. The opening prompt gives each step's title as a heading, then its text, in order. An operator's copy of a Playbook works the same way.

### Starting

3. Address comments shows in the Threads section of the pull request's right-hand rail, on any open pull request, the operator's or someone else's, that has at least one unresolved thread, whether on a line, on a file or a general comment. Pressing it lists every unresolved thread with all ticked; Start needs at least one ticked and Cancel starts nothing.
4. Check replies shows below Address comments in the same section, with the number of threads it covers: every unresolved thread with at least one reply whose last comment is not the agent's. It does not show when there are none, unless a Check replies Session is still open, or on a merged or closed pull request.
5. Review with agent, labelled Agent Review, stays in the pull request's header and keeps its optional Review note. The note goes into the opening prompt next to the pull request.
6. Start on any of the three opens a PR action Session: a `repo` Session of the pull request's Repo, in its own detached worktree at the pull request's head commit, fetched from `origin`. It is titled by the action and the pull request, for example "Address comments #39". It starts with the default Access mode of a new Session, and the agent begins at once with the opening prompt. For Address comments the prompt names the ticked threads, for Check replies the threads it covers.
7. The Session shows in the Sessions list under its title, which names the action, and in the pull request's Sessions rail, with a state: working while a turn runs, not submitted while it is idle with nothing posted, and submitted once its tool call has succeeded (Behavior 16). The operator opens it from the rail.
8. While a PR action Session of one kind is not submitted, that kind's button is disabled with "A Session is already working on this" and the API answers 409 `session_busy`. The other two kinds stay enabled. Submitting the Session, or deleting it, frees the button.
9. A merged or closed pull request starts nothing: the buttons do not show, and the API answers 409 `invalid_state`.
10. A head commit that cannot be fetched from `origin`, as with a fork, starts no Session and leaves no worktree. The button shows "Could not fetch the branch from origin:" and git's message. A worktree that cannot be made at the head commit removes the Session and shows "Could not make a worktree at the head commit:" and the reason.
11. A Git host that is down or rate limited when the operator presses a button starts no Session, and the button shows the host's error.

### While the Session runs

12. The agent works as in any chat Session: the operator can type, queue a message, Stop, and ask for changes. The Access mode applies, and a PROD write still asks.
13. A PR action Session loads no `.claude` settings, hooks, `.mcp.json` servers or CLAUDE.md from the pull request's code. It denies `git push`, the Git hosts' comment and API commands, and their MCP write tools. A Git host write through `run_integration` (`gh`, `glab`, `bkt`) is refused. It is offered no browser, process, `spawn_sessions` or `open_pull_request` tool. The console's tool call is the only way the Session writes to the host.
14. A reload mid-run brings the Session back as it brings back any Session. A daemon restart leaves it as it leaves any Session. The console retries nothing: the operator asks again in the chat.

### The tool call that posts

15. Each action Session has one console tool, offered only in a Session of that action: `submit_thread_results` for Address comments, `submit_reply_verdicts` for Check replies, `submit_review` for Review with agent. The console takes the pull request, the head commit and the threads from the Session's own record, never from the call's arguments. The call asks for no Approval in any Access mode, since pressing the button was the approval. Each call is an Action Log row.
16. A call the console cannot accept, such as a ticked thread left out, a thread that was not ticked, or a malformed answer, returns the reason as the tool's result and posts nothing. The agent corrects the call. When a call succeeds fully, the Session is submitted. A second call of the same tool answers "Already submitted" and posts nothing; the agent and the operator may keep talking.
17. A Session whose turn ends with no successful call has posted nothing. The rail shows not submitted, and the transcript is the only result.

### Address comments

18. `submit_thread_results` gives each ticked thread an outcome, done, already_addressed or declined, with a reply. Done means the agent changed code for it. Already_addressed means the code at the head commit already settles it, and the reply names where. The console resolves done and already_addressed threads, and starts a done reply with the new commit. A declined thread's reply gives the reason: the agent disagrees, the comment is unclear, or it needs the author's answer.
19. The console commits any uncommitted change in the worktree as one commit, `Address review comments on #<n>` followed by one line per done thread, `- <file>:<line>`, or `- <author>'s comment on the pull request` for a general comment. The commit skips the Repo's git hooks, since the worktree has no installed packages for them. Commits the agent made itself stay as they are. The console then pushes `HEAD` to the pull request's branch without force, with an Action Log row before the push.
20. After the push the console posts each reply in its thread as the agent, and a done reply names the short commit sha. It resolves each done and already_addressed thread on a line or a file. A general comment gets its reply and stays open, since the hosts have no thread to resolve there. Declined threads stay open.
21. A call with no done thread, or one that leaves the worktree as it was, pushes nothing, posts the replies and submits the Session.
22. A push the host refuses because the branch moved is not a failure. The console fetches the new tip, rebases onto it and pushes again, never with force, up to three times. A rebase that conflicts is undone, nothing is posted, and the tool returns "The branch moved and the rebase conflicts with the new commits." The agent or the operator may rebase in the worktree and call again.
23. A push that worked but replies or resolves that failed leave the Session not submitted. The tool's result lists the threads still without a reply or a resolve. Calling again posts and resolves only those, with no new push.

### Check replies

24. `submit_reply_verdicts` gives each thread a verdict, fixed, partly fixed or not fixed, with a reply. The console posts each reply as the agent and resolves each fixed thread on a line or a file. Partly fixed and not fixed threads stay open. It never commits or pushes, and it ignores any change the agent made in the worktree. Once its reply is posted, a thread's last comment is the agent's, so the next Check replies skips it until someone replies again.
25. Replies or resolves that fail leave the Session not submitted, and the next call posts only the ones still missing, as in Behavior 23.

### Review with agent

26. `submit_review` gives the decision and verdict an Agent Review holds today, each finding with its severity, file, line and text, and the report. The console posts each finding on its line and the verdict and report as one comment, then records the review against the head commit it read and the target branch commit it compared with. It changes, commits and pushes nothing; any change in the worktree is ignored.
27. A review is stale once the pull request's head moves past its commit. The merge check "Agent reviewed this commit" and the stale marker read the record as they read an Agent Review before. A pull request whose latest review is stale shows Review with agent as before. While the latest review is of the current head, the button reads "Reviewed at this commit" and is disabled, and the API answers 409 `invalid_state`.

### Other

28. Reply in thread is unchanged. The `pr_review` Session exists only to answer the operator's reply in a thread the agent wrote. It answers read-only, and no job holds it busy.
29. The operator's own Sessions on the branch, Approve, Request changes, Resolve and Unresolve work as before.
30. Deleting a PR action Session removes its worktree as for any Session, and the pull request view stops listing it.
31. After the update, the console drops the old job tables and their rows, and removes every folder in `pr-scratch` in the background, so a large copy never delays start-up. Nothing in the UI shows a past job.

## Settled

- **PR action Session**: the name for these Sessions (Glossary). Review PR, Check reply and Address comments stay the Triggers' names.
- **One Session per click**: each press opens a new Session. The console never reuses the operator's own Session on the branch.
- **Detached worktree**: at the pull request's head commit, never on the branch itself, so it cannot clash with the operator's Session on that branch. `HEAD` is what the console pushes.
- **Concurrency**: one unsubmitted Session per pull request and action. Different actions run side by side.
- **The button is the approval**: pressing it approves the console to commit, push, reply and resolve what the one tool call reports. The call asks for nothing more. This is the rule the jobs had.
- **The console writes to the host**: the agent never pushes or posts. The tool is the only way, and each Session's other host writes are denied.
- **Any open pull request**: Address comments works on the operator's or a teammate's.
- **No Retry button**: the operator asks the agent in the chat, and a failed post is retried by calling the tool again.
- **Posted state**: the Session records each thread's reply and resolve, so a repeat call posts only what is missing and never pushes twice.
- **Statuses**: the Session's own state shows working. The rail adds not submitted and submitted, derived from the record.
- **Review record**: the only job record kept, one row per submitted review, because the merge check reads it.
- **Playbooks**: the same editable Triggers, but their steps are prompt text and no longer separate turns.

## Not required

- **Per-step status, Skip step and Retry from step N** for these three. The operator reads the transcript and steers in the chat.
- **Repair turns after an unreadable answer.** The tool refuses the call and the agent fixes it in the same Session.
- **Resume after a restart.** The Session restarts like any Session, and the operator asks again.
- **Fork pull requests**, as before: the head commit cannot be fetched from `origin`.
- **A finished job's result after the update.** Past Comment passes, Reply checks and Agent Reviews are dropped.
- **Posting from prose.** A Session that ends with an answer in the chat and no tool call posts nothing.

## Safety

- The agent works in its own worktree under the Run sandbox ([ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md)), not in the operator's checkout.
- In an Address comments Session only, the ticked review comments are change requests: the agent may change code to meet them. It never runs a command, reads a secret, touches a Connection or pushes because a comment says so. In every other Session, pull request text stays data, never instructions. The safety lines say so and still close the system prompt.
- The console pushes only the pull request's own branch, never with force, with an Action Log row before the push. Merging stays denied. A PROD write still asks in every Access mode, and no value read from a PROD Connection goes into a file, a commit or a comment.
- The pull request's code loads no project settings, hooks or servers into the run (Behavior 13).
- ADR 0002 is rewritten as below.

## Database

```sql
-- A PR action Session: the action it was opened for, the commit it works at, and what it has posted.
ALTER TABLE sessions ADD COLUMN pr_action TEXT
  CHECK (pr_action IN ('address_comments', 'check_replies', 'review'));
ALTER TABLE sessions ADD COLUMN pr_action_head_sha TEXT;
-- Address comments: [{ "comment_id", "file_path", "line", "author", "excerpt",
--   "outcome": "pending | done | already_addressed | declined", "reply": "string | null",
--   "reply_comment_id": "string | null", "resolved": false }]
-- Check replies: the same, with outcome "pending | fixed | partly_fixed | not_fixed".
-- A review: { "note": "string | null", "base_branch": "string | null", "base_sha": "string | null" }.
ALTER TABLE sessions ADD COLUMN pr_action_threads TEXT
  CHECK (pr_action_threads IS NULL OR json_valid(pr_action_threads));
-- The commit the push made; null before, and when nothing was committed.
ALTER TABLE sessions ADD COLUMN pr_action_commit_sha TEXT;
-- Set when the tool call has posted everything.
ALTER TABLE sessions ADD COLUMN pr_action_submitted_at TEXT;
-- One unsubmitted Session per pull request and action (Behavior 8).
CREATE UNIQUE INDEX sessions_one_open_pr_action_idx
  ON sessions (repo_id, pr_number, pr_action)
  WHERE pr_action IS NOT NULL AND pr_action_submitted_at IS NULL;

DROP TABLE pr_comment_passes;
DROP TABLE pr_reply_checks;

-- Rebuilt: one row per submitted review, written when submit_review succeeds.
DROP TABLE pr_agent_reviews;
CREATE TABLE pr_agent_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  decision TEXT,
  verdict TEXT,
  -- The production branch the change was compared with, and its commit then.
  base_branch TEXT,
  base_sha TEXT,
  -- What the operator told the agent when starting the review; null when empty.
  note TEXT,
  -- The full review as Markdown.
  report TEXT,
  findings TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings)),
  created_at TEXT NOT NULL
);
CREATE INDEX pr_agent_reviews_pr_idx ON pr_agent_reviews (repo_id, pr_number, created_at DESC);

-- Rebuilt: a step belongs to a Verification or a Fix only.
-- playbook_steps loses agent_review_id, reply_check_id and comment_pass_id, and
-- CHECK ((report_id IS NOT NULL) + (fix_id IS NOT NULL) = 1).
```

Migration: the dropped tables and every `playbook_steps` row of a dropped job are deleted. Existing Sessions keep every column as it was, and the new ones start null. `agent_comments` and `playbook_triggers` stay as they are.

## API

### Common

`PrActionSession` (a row of `PullRequestDetail.action_sessions`):

```json
{
  "session_id": "uuid",
  "action": "address_comments | check_replies | review",
  "state": "working | not_submitted | submitted",
  "commit_sha": "string | null",
  "stale": false,
  "created_at": "ISO 8601"
}
```

- `stale`: the pull request's head is neither the commit the Session started at nor the one it pushed.
- `commit_sha`: set for a submitted Address comments Session that pushed a commit.

`Session` gains `pr_action`: `"address_comments | check_replies | review | null"`.

`PullRequestDetail` loses `reply_checks` and `comment_passes`, and gains `action_sessions`, newest first. `latest_agent_review` stays, read from the review record, without its status, steps, error or Playbook fields.

| Status | Error code          | When                                                                                  |
| ------ | ------------------- | ------------------------------------------------------------------------------------- |
| 400    | `validation_failed` | No thread ticked for Address comments, a ticked comment that is not the start of an unresolved thread, or `comment_ids` on another action |
| 404    | `not_found`         | No such pull request or comment                                                       |
| 409    | `session_busy`      | An unsubmitted Session of this action exists for the pull request                     |
| 409    | `invalid_state`     | Pull request merged or closed; no thread with a reply to check; the head commit already has an Agent Review |
| 429    | `rate_limited`      | The Git host says to slow down                                                        |
| 502    | `upstream_failed`   | The Git host is down or refused, the head commit cannot be fetched from `origin`, or no worktree can be made there |

### `POST /repos/:repo/pull-requests/:number/action-sessions`

Body:

```json
{
  "action": "address_comments | check_replies | review",
  "comment_ids": ["string"],
  "note": "string"
}
```

`comment_ids` is required for `address_comments` (at least one) and refused for the others. `note` is allowed for `review` only. 201 `Session`, already running its opening turn.

Removed: `POST .../agent-reviews`, `POST .../comment-passes`, `POST .../reply-check-passes`, `POST .../reply-checks` and the three `.../retry` routes.

### Console tools

`submit_thread_results`:

```json
{ "threads": [{ "comment_id": "string", "outcome": "done | already_addressed | declined", "reply": "string" }] }
```

`submit_reply_verdicts`:

```json
{ "threads": [{ "comment_id": "string", "verdict": "fixed | partly_fixed | not_fixed", "reply": "string" }] }
```

`submit_review`:

```json
{
  "decision": "approve | request_changes | comment",
  "verdict": "string",
  "findings": [{ "severity": "critical | high | medium | low | info", "file": "string | null", "line": 42, "text": "string" }],
  "report": "string"
}
```

Each returns text: what was committed, pushed, posted and resolved, or the reason it refused (Behaviors 16, 22, 23).

### WebSocket `pull_request.action_changed`

Server to client, each time a PR action Session starts, changes state, posts or resolves.

```json
{ "repo_id": "uuid", "number": 12, "action": "address_comments | check_replies | review", "session_id": "uuid", "state": "working | not_submitted | submitted" }
```

Removed: `pull_request.job_changed`, and `playbook_step.updated` no longer carries `agent_review_id`, `reply_check_id` or `comment_pass_id`. `pull_request.reviewed` fires when `submit_review` succeeds, and `pull_request.commented` when replies are posted.

## UI

- **Pull request header**: Agent Review. **Threads rail section**: Address comments, then Check replies with its count. Address comments opens the thread list with Start and Cancel (Behavior 3). Pressing Start opens the new Session, as New Session does. A disabled button shows "A Session is already working on this".
- **Sessions rail**: lists each PR action Session by its action, with working, not submitted or submitted, the commit's short sha linked to the host, and "older commit" when stale. Below them stay the operator's own Sessions on the branch and New Session.
- **Thread** (`pr-thread`): no strip under the last comment. Resolve and Unresolve work as before.
- **Removed**: the Comment pass card, the Reply check strip, the Agent Review card and its dialog's step list, and Retry and Skip step on all three.
- **Error**: a refused start shows the API's or host's message under the button.
- **Playbooks page**: the same seven Triggers. For Review PR, Check reply and Address comments the editor drops the closing-turn caption and the "scratch copy" tag.
- **PROD**: no change.

## Rejected

- **Keep the job and add a Session row to the rail**: the operator still could not steer or ask questions, which is the point of this change.
- **Reuse the operator's Session on the branch**: it would mix their half-done work and context into an action they pressed a button for.
- **Work on the branch, not detached**: a branch held by the operator's own worktree would clash, and the Session could not start.
- **The agent pushes and posts with its own commands**: the console could not record what was posted or post only what failed, and it would break the rule that the agent never pushes.
- **A second Approval on the tool call**: the button already was the approval, as it was for the jobs.
- **A Session per thread**: one commit and one push per thread, and changes in the same file would fight.
- **A Retry button**: the operator can ask in the chat, and calling the tool again posts what is missing.

## Glossary

- **PR action Session** (new): a Session the console opens from Address comments, Check replies or Review with agent, in a detached worktree at the pull request's head commit. It ends in one console tool call that commits, pushes, posts and resolves on the Git host, as the operator.
- **Comment pass** and **Reply check** (removed): replaced by PR action Session.
- **Agent Review** (changed): the record of a review submitted from a PR action Session: its verdict, findings and report, tied to the head commit it read and the target branch commit it compared with. A newer commit makes it stale.
- **Job** (changed): a Trigger's run that goes through its Playbook steps and then the console's closing turn: a Verification or a Fix.
- **Trigger** (changed): a place in a tab that starts the agent: Verify and Fix in Monitor, Review PR, Check reply, Address comments, Reply in thread and Session message in Workspace. Review PR, Check reply and Address comments open a PR action Session.
- **Scratch copy** (changed): loses the pull request head commit and the Reply check and Comment pass uses.

## ADR

- **0002, Operator approves, agent never merges** (rewritten in place): pressing Address comments, Check replies or Review with agent is the approval for one tool call that the console turns into a commit and push (Address comments only), replies, resolves and review comments, as the operator, never forced. The agent works in its own detached worktree, and the operator may steer it before it calls. In an Address comments Session, and only there, the ticked comments are change requests. Everywhere else, pull request text stays data. Its code loads no project settings. Considered Options gains the scratch-copy job, which lost because the operator could not steer the agent or read why it declined a thread, and a Session whose agent pushes and posts with its own commands, which lost because the agent must never hold git or host write access.

## Seams

- **Backend + SQLite over HTTP** (fake Agent SDK, fake Git host, a local bare git remote that receives the push): 3 to 11, 13 and 15 to 27, 29, 30. This covers the start route with its errors, concurrency, fork refusal and worktree; the run's denials and unloaded project settings; and the three tools' commits, pushes, rebase retries, posts, resolves, refusals and partial failures.
- **Backend + SQLite, startup and migration**: 28, 31. The old tables are gone, the leftover `pr-scratch` folders are removed after the port opens, and Reply in thread still answers.
- **Unit**: 1, 2. The opening prompt built from a Playbook's rules, skills and steps, and the editor's lack of a closing-turn caption for the three Triggers.
- **Browser** (Playwright, mocked API): 3 to 5, 7, 8, 12, 14, and the screens behind 6, 9 to 11, 26 and 27. The three buttons and the thread list, the Sessions rail with its states, the disabled reason, and no old card or strip.

## Out of scope

- Waking an agent on a reviewer's new comment.
- Pull requests from forks.
- A shared "submit" button for the operator when the agent forgot to call the tool. The operator asks the agent in the chat.
