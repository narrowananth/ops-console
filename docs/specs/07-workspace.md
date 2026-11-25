# Workspace: repo Sessions, branches and pull requests

**Status:** shipped; Agent Reviews (Behaviors 16 and 18) run as PR action Sessions ([pr-actions-open-sessions](pr-actions-open-sessions.md)), and the Workspace lists and the pull request page follow [workspace-inbox-and-pr-cockpit](workspace-inbox-and-pr-cockpit.md)
**Design:** Workspace in `design/workspace-variants.html` (Sessions inbox) and `design/workspace-pr-variants.html` (pull request cockpit), on the layout of `design/ops-console-sidebar.html`; the Session panel in `design/ops-console-t3-shell.html`

## Problem

The operator works with the agent inside a Repo: one Session per piece of work, each on its own branch, and the pull requests that come out of them. They need to switch branches without losing uncommitted work, read and answer PR comments without leaving the console, and get the agent's review of a PR posted where the rest of the team reads it. Pull requests already live on the Git host. The console should show them live, and keep only what the host does not know: Agent Reviews, which comments the agent wrote and the state of each PR action Session.

## Behavior

Sessions in a Repo

1. Creating a `repo` Session needs a Repo and one of its local branches; a branch the Repo does not have is `validation_failed`. With `from_origin: true` such a branch, as a pull request's, is fetched from origin and made a local branch tracking it, without a checkout; that step writes an Action Log row of kind `git` first, and a branch origin does not have is `upstream_failed`. A request with no `kind` makes a `repo` Session. With `new_branch: true` a branch no one has is made at the newest commit of the Repo's default branch, fetched from origin first, and that step also writes an Action Log row of kind `git`. Model, effort and access mode come from the session defaults unless the request sets them (`02-settings-agents`).
2. Each `repo` Session works in a Session worktree of its own under the data folder, made when the Session is (`session-worktrees`). Sessions run side by side, in one Repo or in several. A second message to a Session whose run is still going is refused with `session_busy` (`02-settings-agents`).
3. Removing a Repo that has Sessions asks the operator, in the Repo's row, to keep or delete them. Kept, the Repo
   and its Sessions leave every list, a run still going finishes unseen, and importing the same folder again brings
   back the Repo, its Sessions, Agent Reviews and agent comments. Deleted, they go with the Repo; that waits until no
   Session in it is running (`session_busy`). Either way, Services linked to it lose the link. Without a choice the
   daemon refuses with `repo_has_sessions`.
4. Deleting a Session removes its worktree and keeps its branch, its Agent Reviews and the comments the agent posted.

Branches

5. Each branch in the Repo's branch list (`06-settings-repos`) also says whether it has an open pull request.
6. Checking out a branch for a Session changes its worktree only. Uncommitted changes there are stashed first, and the response says so (`stashed: true`). With `create: true` it makes a new branch from the current one and checks it out. A branch the Repo's own folder holds is checked out detached at its commit, moved forward to origin, and the Session keeps the branch's name. The Session's `branch` follows, and `session.updated` carries it.
7. Checkout is refused with `invalid_state` for any Session that is not a `repo` Session and while the Session is not `idle` or `failed`. The branch menu also stays shut while any other Session in that Repo is `working` or `waiting_approval`.
8. Checkout, branch creation and stash each write an Action Log row of kind `git` before they run.
30. When a run in a `repo` Session ends, an `idle` or `failed` Session moves to the branch its worktree is on, as when the agent made a branch for its fix. Committing on a new branch moves it too (`session-panel-and-subagents`). A detached HEAD, which a Session on the default branch or on a branch the Repo's folder holds starts with, leaves the Session on the branch it has. A run that worked outside the worktree, as a Verification in its scratch copy does, never moves it. Each new Session starts on the branch it was created with, normally the default branch; an Alert's Session starts on the default branch. `session.updated` carries the move. Reading the diff does not move it.
31. A `repo` Session's diff is what its own worktree changes, read from the worktree. Its `branch` is the one checked out in the worktree, since the agent may have moved to a new one; on a detached HEAD the Session's own branch holds. The changes are compared with where the branch forked from the default branch: origin's when origin has it, else the Repo's. It holds the branch's commits and the staged, unstaged and untracked files. Other Sessions have worktrees of their own, so their branches and uncommitted work never show in this one's diff. On the default branch, the diff holds the commits not pushed and the uncommitted files. Each file has its status, counts and lines. A file's lines stop at 3000. A binary file, or an untracked one over 512 KB, shows without lines, and at most 200 untracked files are read. A Session with no worktree yet has an empty diff. Any other kind of Session answers `invalid_state`.

Pull requests

9. Listing pull requests reads the Git host, kept in the daemon's memory per Repo. A list under 30 minutes old is served as is. An older one is served at once while the host is read again in the background; when that read finds a pull request added, gone or changed, `pull_request.refreshed` goes out with them in `changed`, and the next list has it. For an owner's list (Behavior 23) the event carries a null `repo_id` and an empty `changed`. A pull request's detail is kept the same way for 15 seconds, and a change to it goes out as `pull_request.refreshed` with that pull request. Refresh drops that cache and reads again in the background. With nothing kept, the list waits for the host. A search by words filters the kept list and reads nothing. A search of just a number (`42` or `#42`) asks the host for that number, in any state, in every project the list knows and every imported Repo, through the adapter's `find`, and lists what the host answers in the list's own state; each answer is kept 60 seconds, and a host that fails marks the answer stale.
10. When the host rate limits or fails on a background read, the kept list comes back with `meta.stale: true` from the next list on, and a failed read is tried again after 5 minutes. After a rate limit (429) the console reads nothing from that host for 10 minutes, serves the kept lists as stale, and a Refresh keeps what a rate limited host had. With nothing cached it returns `rate_limited` or `upstream_failed`. The cache is empty after a daemon restart.
11. Posting a comment, a reply, a resolve or a delete goes to the host. On failure nothing changes. On success the comment, the counts and the thread's state are written into the kept lists and the kept detail, so no host read follows. An inline comment attaches to the commit the pull request is at when it is posted.
12. A pull request is `is_mine` when its `author` equals the `login` on the Git host's Connector (`04-settings-connectors`), or when a `repo` Session of the console worked on its branch (`by_agent`). A pull request of a repository that is not an imported Repo is `by_agent: false`.
13. Approving or requesting changes on a PR whose `author` equals that `login` is refused with `invalid_state`. Commenting is allowed.
14. `comment_count` counts every comment, replies included. `resolved_count` counts resolved threads.
15. Merging is an operator endpoint. It reads the review state from the host and needs the pull request `open` and `approved`, else `invalid_state`. It writes an Action Log row of kind `pr`, as the operator, before calling the host. If the host rejects it, the PR stays open and the response is `upstream_failed`; a host that rate limits answers `rate_limited`. On success the kept lists and detail are read again from the host.
23. With no `repo_id`, the list covers every repository on each connected host: per owner the host lets the operator read (the GitHub login and its orgs, the Bitbucket workspaces from `/user/workspaces`, the GitLab user and top-level groups), plus the Connector's own workspace or org and the owners of imported Repos. Each owner's list is kept like a Repo's; the owners are kept 10 minutes, an empty or failed answer too. Hosts and owners are read side by side. A pull request whose repository is an imported Repo carries its `repo_id`; any other has a null `repo_id`. Every one carries `host` and `slug`. A Bitbucket workspace is read for its 300 most recently updated repositories, several at a time. An owner that fails leaves the rest listed and sets `meta.stale`; an owner the host does not have (a renamed or deleted organization) lists nothing. An imported Repo whose repository the host lists under a new owner takes the host's `owner/name` (`repo-follows-host-owner`).

Agent Review and the agent's voice on a PR

16. Review with agent starts a PR action Session with `POST /repos/:repo/pull-requests/:number/action-sessions` (`pr-actions-open-sessions`): a `repo` Session in a detached worktree at the pull request's head commit. Its prompt holds the pull request and its diff, its open threads (the agent checks its own earlier findings again and does not repeat what others' threads say), the operator's optional note and the Review PR Playbook. Starting a review on a commit that already has one is refused with `invalid_state`, and while an unsubmitted review Session exists for the pull request with `session_busy`. The Session ends in the console tool `submit_review`, which records a row with the Repo, PR number, the PR's `head_sha`, the Session, the verdict, findings and report. A review whose `head_sha` differs from the PR's current one reads as `stale`. A Session whose turn ends with no successful call records nothing.
16a. Address comments and Check replies start PR action Sessions through the same route, in the same kind of worktree (`pr-actions-open-sessions`). Address comments takes the ticked unresolved threads as `comment_ids`. Its console tool `submit_thread_results` gives each thread `done`, `already_addressed` or `declined` with a reply. The console commits the worktree's changes as one commit, pushes it to the pull request's branch without force, posts each reply as the agent and resolves the `done` and `already_addressed` threads on a line or a file. Check replies covers every unresolved thread with a reply whose last comment is not the agent's, or only the threads named in `comment_ids`. Its tool `submit_reply_verdicts` gives each thread `fixed`, `partly_fixed` or `not_fixed` with a reply; the console posts the replies and resolves the fixed threads, and commits and pushes nothing. Each reply is recorded in `agent_comments`. An Action Log row exists before each push, reply and resolve. Either action on a merged or closed pull request is `invalid_state`, and a second one of the same action while one is not submitted is `session_busy`.
17. A pull request has at most one `pr_review` Session. The backend creates it on the first reply the operator posts in a thread the agent started. It has no composer: sending it a message is refused with `invalid_state`.
18. When `submit_review` is called, each finding is posted to the host as an inline comment on its file and line; a finding with no file or line posts as a general comment. An Action Log row of kind `pr` exists before each post. Each comment the host accepts is recorded in `agent_comments`. One failed post does not stop the others; the finding records `post_error`. A finding on a file and line where an earlier review's agent thread is still open is not posted again: its `comment_id` points at that thread. The console then posts the summary as one comment and writes the review row.
19. When the operator replies in a thread whose first comment is in `agent_comments`, the reply goes to the host and the `pr_review` Session gets the thread and answers read-only. A second reply waits until the answer in progress ends. The answer is posted in that thread with an Action Log row first, and recorded in `agent_comments`. A reply in any other thread does not start the agent.
20. A comment is `by_agent` when it is in `agent_comments`. It is `is_mine` when it is `by_agent` or its author is the host Connector's login. `DELETE /repos/:repo/pull-requests/:number/comments/:comment_id` deletes an `is_mine` comment on the host and its `agent_comments` row, and answers 204; anyone else's is refused with `invalid_state` before the host is asked. An id the host does not list is `not_found`.

Reading a pull request

24. `approved_by` lists who approved the pull request, as the host names them: GitHub's latest review per reviewer that is `APPROVED`, Bitbucket's participants with `approved`. GitLab lists none.
25. `GET /repos/:repo/pull-requests/:number/file?path=&ref=` answers one file's text at commit `ref`, read from the host. `ref` is a commit id; anything else is `validation_failed`. A file not there at `ref` answers `text: null`.
26. Resolving or unresolving takes a thread's first comment; a reply is refused with `invalid_state`, and an id the host does not list is `not_found`.
27. `q` matches a pull request's number (`#42` or `42`) and title, ignoring case, and also its author, or under `mine=true` the Connector's `login`. `mine=true` keeps the `is_mine` ones. The list comes newest `opened_at` first.
28. Refresh with no `repo_id` also forgets the owners (Behavior 23) and every owner's list, so the next list reads them again; a rate limited host keeps what was read. Its `pull_request.refreshed` reports the reads of the imported Repos.
29. A `local` Repo has no pull requests: its list and every pull request endpoint under it answer `invalid_state`. On GitLab every endpoint but the list answers `upstream_failed`.
32. The detail of a pull request has `commits`, the branch's commits its base lacks, oldest first, as the host lists them. An open one also has `conflicts`: whether the branch merges into its base as both stand on origin. It reads `checking` until a background check lands, then `clean`, `conflict` with the files, or `unknown` when git cannot fetch. The check fetches the base, and the head when the Repo lacks it, into the Repo's folder and runs `git merge-tree`, which touches no branch and no work tree. It is kept two minutes per head commit, and a result that differs goes out as `pull_request.refreshed` for that pull request. A pull request that is not open has `conflicts: null`.

Pull requests of a Session, and committing from one

33. A `repo` Session lists the pull requests the console opened for it, newest first, as `pull_requests` (number, URL, branch). `pull_request` is the open one on the branch the Session is on, or null (`session-pull-requests`).
34. A `repo` Session's worktree is committed with `POST /sessions/:id/commit`, pushed with `POST /sessions/:id/push` and opened in the editor or the file manager of this machine with `POST /sessions/:id/open-folder` (`session-panel-and-subagents`). A commit takes every change, skips the Repo's git hooks, and with `new_branch` lands on a new `ops/<words>` branch that the Session follows. It is refused with `invalid_state` while the Session runs, with no worktree or with nothing to commit. A push never forces and rebases onto a branch that moved on origin. It is `invalid_state` for a Session with no worktree and on the default branch, and `branch_moved` when the rebase conflicts. Commit and push each write an Action Log row of kind `git` first.

Anonymous Sessions

21. Creating an `anonymous` Session needs no Repo and no branch. It works in its own folder, `anonymous/<session id>` in the data directory, made when the Session is. The agent may clone into it; the Monitor clones a Service's Git URL into one (`08-monitor-dashboard`).
22. An `anonymous` Session's `branch` is the branch of the clone in its folder, null before there is one. It has no branch switcher. Deleting it leaves its folder.
22a. When the operator names an imported Repo in an `anonymous` Session, the agent asks to move the Session into it and, once approved, the Session becomes a `repo` Session (`anonymous-joins-repo`).

## Settled

- **Git host adapter**: one interface over `github`, `gitlab`, `bitbucket` and `local`, reached through the hosts' CLIs (`gh`, `bkt`, `glab`), per ADR 0005. Listing and reading PRs is a fixed read with no model turn. `local` has no pull requests. Tests use a fake. GitHub (`gh api`) and Bitbucket Cloud (`bkt api`) do everything; GitLab (`glab api`) lists and opens merge requests only (Behavior 29).
- **`by_agent` on a pull request**: a `repo` Session works on the PR's branch. The console keeps no record of who ran `gh pr create`, so the Session is the evidence.
- **Agent Review output**: the agent calls `submit_review` with `decision`, `verdict`, `findings` and `report`; the report holds the PROD readiness checklist and the Connections used. After the findings, the console posts one comment on the pull request: `**Agent Review** · <VERDICT> at <commit> · <counts>`, the verdict sentence and the report. A refused summary post still leaves the review recorded.
- **Starting runs**: the operator's button starts a PR action Session and its run. The `pr_review` Session's runs are the console's own, one thread answer at a time.
- **Pull request cache**: per Repo and state, per owner and state, and per pull request detail, in the daemon's memory. Posting, resolving or deleting a comment writes the change into the kept lists and detail. Reviewing and merging read the pull request again from the host before they answer, and a PR action Session's posts read it in the background; each places the result in the lists of its state. A pull request the console opens is placed in the kept lists at once. Refresh drops the Repo's lists, details and conflict checks and its owner's list. Only one background read per entry runs at a time. The branch list reads the open list through the same cache, and lists no open PR marks when the host fails.
- **Aggregate list**: with no `repo_id`, a Repo whose host Connector is not connected is skipped. With a `repo_id` it answers `connector_not_connected`.
- **Pull request identity**: Repo and number for an imported Repo; host, slug and number otherwise. No `pull_requests` or `pr_comments` table.
- **Stored here**: Agent Reviews, the ids of comments the agent posted, and the PR action Sessions' state. Everything else about a PR comes from the host.
- **Session rules in code**: a `repo` Session has a Repo and a branch, and a PR action Session has a Repo and a PR number instead; a `pr_review` Session has a Repo and a PR number; an `anonymous` Session has no Repo and may have a branch; other kinds have neither. SQLite cannot add these as `CHECK`s to an existing table, so the session service enforces them.
- **Agent Review content**: a verdict, findings, the full report, the target branch and commit it compared with, and the operator's note. Reviews stored with `blocker`, `suggestion` and `nit` read as `high`, `medium` and `info`.
- **Reactions**: not read. PR comment likes are dropped from the design.

## Not required

- **Fresh PR data**: a list can be up to 30 minutes old, plus the time its background read takes, or older with `meta.stale` while the host fails. The UI starts the first list read (Mine, no search) as the app opens, so the Workspace finds it kept.
- **Every pull request of a large owner**: an open list follows up to 40 pages of a Repo on every host, GitHub's search of an owner stops at 1000 pull requests, and a Bitbucket workspace is read for 300 repositories (Behavior 23). Merged and closed lists read one page. The rest are not listed.
- **PRs offline**: with the host unreachable after a restart, the PR list is an error until the host answers.
- **Thread answers while the daemon is down**: a reply posted on the host directly, not through the console, does not wake the agent.

## Safety

- The agent has no merge tool on any host. Every run denies `gh pr merge`, `glab mr merge`, `bkt pr merge`, `bkt pr auto-merge`, the GitHub and GitLab MCP merge tools and the hosts' merge endpoints, in every Access mode (ADR 0002). The only merge path is the operator's merge endpoint, which needs an open, approved pull request.
- The agent posts on a pull request only after the operator presses Agent Review, Address comments or Check replies, or replies in a thread the agent started. A PR action Session posts through its one console tool, as the operator, and pushes only the pull request's own branch, never forced. Its run denies `git push`, the Git hosts' comment and API commands and their MCP write tools, and loads no project settings. Every post, push and git action writes an Action Log row first.

## Database

```sql
ALTER TABLE sessions ADD COLUMN repo_id TEXT REFERENCES repos (id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD COLUMN branch TEXT;        -- repo Sessions: the branch; anonymous Sessions: the clone's branch
ALTER TABLE sessions ADD COLUMN pr_number INTEGER;  -- pr_review and PR action Sessions: the PR in repo_id
CREATE INDEX sessions_repo_idx ON sessions (repo_id, last_active_at DESC);
CREATE UNIQUE INDEX sessions_one_pr_review_idx ON sessions (repo_id, pr_number) WHERE kind = 'pr_review';

-- PR action Sessions (pr-actions-open-sessions)
ALTER TABLE sessions ADD COLUMN pr_action TEXT CHECK (pr_action IN ('address_comments', 'check_replies', 'review'));
ALTER TABLE sessions ADD COLUMN pr_action_head_sha TEXT;     -- the commit its worktree was made at
ALTER TABLE sessions ADD COLUMN pr_action_threads TEXT CHECK (pr_action_threads IS NULL OR json_valid(pr_action_threads));
ALTER TABLE sessions ADD COLUMN pr_action_commit_sha TEXT;   -- the commit the push made
ALTER TABLE sessions ADD COLUMN pr_action_submitted_at TEXT; -- set once the tool call has posted everything
CREATE UNIQUE INDEX sessions_one_open_pr_action_idx ON sessions (repo_id, pr_number, pr_action)
  WHERE pr_action IS NOT NULL AND pr_action_submitted_at IS NULL;

CREATE TABLE pr_agent_reviews (
  id          TEXT PRIMARY KEY NOT NULL,
  repo_id     TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,                     -- the commit that was reviewed
  session_id  TEXT REFERENCES sessions (id) ON DELETE SET NULL,  -- the PR action Session that submitted it
  decision    TEXT,                              -- ReviewVerdict
  verdict     TEXT,
  base_branch TEXT,                              -- the target branch compared with
  base_sha    TEXT,                              -- its commit then; null when it could not be fetched
  note        TEXT,                              -- the operator's note when starting; null when empty
  report      TEXT,                              -- the full review as Markdown
  findings    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings)),   -- [{ severity, file, line, text, comment_id, post_error }]
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX pr_agent_reviews_pr_idx ON pr_agent_reviews (repo_id, pr_number, created_at DESC);

CREATE TABLE agent_comments (
  repo_id          TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  pr_number        INTEGER NOT NULL,
  comment_id       TEXT NOT NULL,                -- the host's comment id
  agent_review_id  TEXT REFERENCES pr_agent_reviews (id) ON DELETE SET NULL,  -- always null today
  posted_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo_id, pr_number, comment_id)
) STRICT;
```

`session_pull_requests` is in `session-pull-requests`.

| Enum | Values | Columns |
| ---- | ------ | ------- |
| `FindingSeverity` | `critical`, `high`, `medium`, `low`, `info` | `findings[].severity` |
| `ReviewVerdict` | `approve`, `request_changes`, `comment` | `pr_agent_reviews.decision` |
| `PrAction` | `address_comments`, `check_replies`, `review` | `sessions.pr_action` |
| `PrActionState` | `working`, `not_submitted`, `submitted` | API only |
| `PrState` | `open`, `merged`, `closed` | API only |
| `PrReviewState` | `none`, `approved`, `changes_requested` | API only |
| `PrChecks` | `none`, `running`, `passed`, `failed` | API only |
| `PrMergeState` | `checking`, `clean`, `conflict`, `unknown` | API only |
| `PrReviewEvent` | `approve`, `request_changes`, `comment` | API only |

Migration of existing rows: none; existing Sessions get null in the new columns.

## API

### Common

Errors added here:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `repo_has_sessions` | Removing a Repo with Sessions without `sessions=keep` or `delete` |

`PullRequest`, read from the host: `repo_id` (null when not imported), `host`, `slug` (`owner/name`; GitLab `group/subgroup/name`), `number`, `url`, `title`, `author`, `branch`, `base_branch`, `head_sha`, `state`, `review_state`, `approved_by`, `checks`, `additions`, `deletions`, `body`, `opened_at`, `merged_at`, plus `is_mine`, `by_agent`, `comment_count`, `resolved_count`, `agent_session_id` (the `pr_review` Session, or null), `latest_agent_review` (`PrAgentReview | null`, with `stale: boolean`). A list row leaves out `body` and carries `latest_agent_review` as `{ decision, stale }`. The detail response always has a `repo_id`, and adds `files` (`[{ name, additions, deletions, lines: [{ sign, text }] }]`), `comments: PrComment[]`, `action_sessions: PrActionSession[]` (newest first), `commits: PrCommit[]` (oldest first; `sha`, `message`, `author`, `created_at`, `url`) and `conflicts` (`{ state, files, checked_at }`; Behavior 32).

`PrComment`, read from the host: `id` (the host's id), `parent_id`, `author`, `by_agent`, `is_mine` (Behavior 20), `body`, `file_path`, `line`, `resolved` (thread roots; replies read `false`), `created_at`, `reply_count`.

`PrAgentReview`: all `pr_agent_reviews` columns, plus `stale: boolean`.

`PrActionSession`: `session_id`, `action`, `state` (`working` while a turn runs, `not_submitted` while it is idle with nothing posted, `submitted` once its tool call has posted everything), `commit_sha` (the commit an Address comments Session pushed, else null), `stale` (the pull request's head is neither the commit the Session started at nor the one it pushed) and `created_at`.

`Session` carries `branch`, `pr_action` (`address_comments`, `check_replies`, `review` or null), `pull_request`, `pull_requests` (Behavior 33) and `subagents` (`session-panel-and-subagents`).

Every route under `/repos/:repo/pull-requests` answers `invalid_state` for a Repo with no Git host (Behavior 29) and `connector_not_connected` while the host's Connector is not connected.

### `POST /sessions` (extends `02-settings-agents`)

Adds `repo_id` and `branch`, required for kind `repo`, which is also the kind of a body with no `kind`. An optional `from_origin` makes a branch only origin has, and an optional `new_branch` makes a branch no one has (Behavior 1). Kind `anonymous` takes neither, and an optional `title`. `pr_review` is never accepted. Errors: `validation_failed` when a `repo` Session misses either or names a branch the Repo does not have; `not_found` for an unknown Repo.

### `GET /repos/:id/branches` (extends `06-settings-repos`)

Each branch adds `has_open_pr: boolean`: whether the Git host lists an open pull request from it.

### `POST /sessions/:id/checkout`

```json
{ "branch": "string", "create": false }
```

Answers 200 with `{ "data": { "session": "Session", "stashed": false } }`. Errors: `invalid_state` (Behavior 7), `upstream_failed` when git refuses.

### `POST /sessions/:id/attachments?name=`

Body: the file's bytes. Saves it under a new name in `attachments/<session id>/` in the data folder. 201 `{ "data": { "name": "string", "path": "string", "size": 1234, "type": "string" } }`, `type` being the media type the message tells the agent. An empty file is `validation_failed`.

### `GET /sessions/:id/attachments/:file`

Answers the bytes of a file saved for the Session's messages, `:file` being the last part of its saved path, with its type: images, PDFs, video and audio as themselves, `.txt`, `.log`, `.json`, source files and other text as `text/plain`, anything else, HTML and SVG included, as bytes. A name that is not a saved file in the Session's folder, or a Session that does not exist, is `not_found`.

### `GET /sessions/:id/diff`

Answers `{ "data": SessionDiff }` (Behavior 31): `branch` (the branch checked out in the worktree, the Session's own on a detached HEAD), `base` such as `origin/main` (null when the Repo has no commit), `additions`, `deletions`, and `files`, A→Z. Each file has `name`, `old_name` (renames only), `status` (`added`, `modified`, `deleted`, `renamed`), `additions`, `deletions`, `binary`, `lines` (`sign` and `text`, hunk headers kept) and `truncated`. Errors: `invalid_state` for a Session that is not `repo`, `not_found`.

### `POST /sessions/:id/commit`, `POST /sessions/:id/push`, `POST /sessions/:id/open-folder`

Behavior 34.

| Route | Body | Returns |
| ----- | ---- | ------- |
| `POST /sessions/:id/commit` | `{ message?, new_branch? }` | 201 `{ sha, branch, message, files }`; `invalid_state`, `upstream_failed` |
| `POST /sessions/:id/push` | | 200 `{ branch }`; `invalid_state`, `branch_moved`, `upstream_failed` |
| `POST /sessions/:id/messages/:message_id/fork` | none | 201 and the new Session; `message_id` is a finished agent response; 404 for any other message, 409 for a Session that cannot fork or has no conversation yet |
| `POST /sessions/:id/open-folder` | `{ target: "editor" \| "folder" }` | 204; `invalid_state` when the Session has no folder, `upstream_failed` when the machine cannot open it |

`GET /sessions/:id/pull-request`, `POST /sessions/:id/pull-request-draft` and `POST /sessions/:id/pull-request` belong to `console-opens-pull-request`.

### Pull requests

`:repo` is the Repo id.

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /pull-requests` | query `repo_id?`, `state?` (default `open`), `mine?`, `q?` | `PullRequest[]` without detail fields, each with `host`, `slug` and `repo_id` (null when not imported). `meta` adds `synced_at` and `stale` |
| `POST /pull-requests/refresh` | `{ repo_id? }` | 202 `{ "data": { "accepted": true } }`; drops the cache. The outcome comes on `pull_request.refreshed` |
| `GET /repos/:repo/pull-requests/:number` | | `PullRequest` with `files` and `comments` |
| `GET /repos/:repo/pull-requests/:number/file` | query `path`, `ref` | `{ path, ref, text }` (Behavior 25) |
| `POST /repos/:repo/pull-requests/:number/comments` | `{ body, file_path?, line?, parent_id? }` | 201 `PrComment` as the host returned it; `upstream_failed` |
| `PATCH /repos/:repo/pull-requests/:number/comments/:comment_id` | `{ resolved }` | `PrComment`; thread roots only (Behavior 26) |
| `DELETE /repos/:repo/pull-requests/:number/comments/:comment_id` | | 204; `invalid_state` for a comment not `is_mine`, `not_found` (Behavior 20) |
| `POST /repos/:repo/pull-requests/:number/reviews` | `{ event, body? }` | `PullRequest` with `files` and `comments`; `body` required unless `approve`, else `validation_failed`; `invalid_state` on your own PR (Behavior 13) |
| `POST /repos/:repo/pull-requests/:number/merge` | | `PullRequest` with `files` and `comments`; `invalid_state` unless `open` and `approved`; `upstream_failed`, `rate_limited` |
| `POST /repos/:repo/pull-requests/:number/action-sessions` | `{ action, comment_ids?, note? }` | 201 `Session`, already running its opening turn. `comment_ids` is required for `address_comments` (at least one), optional for `check_replies` (the threads to check) and refused for `review`; `note` is for `review` only. Errors: `validation_failed`, `not_found`, `session_busy` (an unsubmitted Session of the action exists), `invalid_state` (merged or closed pull request, no thread with a reply to check, a commit that has an Agent Review), `rate_limited`, `upstream_failed` (the host is down, the head commit cannot be fetched from `origin`, or no worktree can be made there). See `pr-actions-open-sessions` |
| `GET /repos/:repo/pull-requests/:number/agent-reviews` | | `PrAgentReview[]`, newest first |

### WebSocket `pull_request.refreshed`

Server to client, when a Refresh ends, and when a background read finds a change (Behavior 9).

```json
{ "repo_id": "uuid | null", "status": "ok | rate_limited | failed", "changed": [{ "repo_id": "uuid", "number": 0 }] }
```

### WebSocket `pull_request.commented`

Server to client, when the host accepts a comment the agent posts: a finding, a reply from a PR action Session or an answer in a thread.

```json
{ "repo_id": "uuid", "number": 0, "comment_id": "string", "by_agent": true }
```

### WebSocket `pull_request.reviewed`

Server to client, when `submit_review` has posted its findings and the review is recorded. `status` is `ready`; `post_failed` counts the findings and the summary the host refused.

```json
{ "repo_id": "uuid", "number": 0, "agent_review_id": "uuid", "status": "ready | failed", "posted": 0, "post_failed": 0 }
```

### WebSocket `pull_request.action_changed`

Server to client, each time a PR action Session starts, begins or ends a run, is deleted, or posts.

```json
{ "repo_id": "uuid", "number": 0, "action": "address_comments | check_replies | review", "session_id": "uuid", "state": "working | not_submitted | submitted" }
```

### WebSocket `session.updated` (extends `02-settings-agents`)

Adds `branch: string | null`.

## UI

- Workspace has two tabs, Sessions and Pull requests. The tab, the picked Session and the picked pull request live in
  the address (`?session=<id>`, `?tab=pulls&pr=<repo id>/<number>`), so a reload, Back or a copied link opens them;
  the Monitor links to a Fix's Session this way. A picked Session that is gone drops out of the address. With nothing
  picked: "Pick a Session, or start one on a branch." or "Pick a pull request." The choices and drafts named below
  stay in the browser's local storage (`persist-selections-and-runs` Behaviors 1 to 10).
- The arrow beside the tabs, as tall as them, folds the side panel to a narrow rail, and the browser remembers it folded. The rail has
  the arrow to open it again and an icon for each tab, which opens the panel on that tab. The Sessions icon counts
  the Sessions waiting on the operator (`waiting_input` or `waiting_approval`).
- Sessions inbox (`workspace-inbox-and-pr-cockpit`): a flat list grouped Needs you (waiting on a question or an Approval,
  or failed), Running and Idle, each in last-active order. It lists `repo` Sessions, PR action Sessions among them, and
  anonymous Sessions; `pr_review` Sessions are not listed, and a Repo with no Session does not show. A row has three
  lines. The first holds the Repo's badge and name ("No Repo" for an anonymous Session), a "Working" chip with the run's
  minutes while it runs, one word for what the Session waits on (`approval`, `question` or `failed`) and the time since it
  was last active. The second holds a state dot and the title. The third holds the branch, a pull request mark (the number,
  or `+N` for several, coloured by the newest one's state) and the model. A row whose run goes, `waiting_input` included,
  shows `stop` over its state and time on hover or focus. After a short rest on a row, a hover card shows the title, the
  Repo and its host, the branch, what the state means, model, effort and Access mode, when the Session started and was
  last active, and each pull request with its number and title (`session-pull-requests`). Idle lists its first 8 Sessions,
  then "Show N more" or "Show fewer"; a search, or the open Session, lifts the limit. The search box, "Search Sessions",
  matches a title, a branch, the Repo's name or checked-out branch, and a pull request number written `#12`. The tabs
  All, Needs you and Running, each with its count when above zero, and a Repo picker ("All Repos", "No Repo", then the
  Repos A→Z) narrow the list. A group's header folds it. The tabs, the picker, the folds and the search are kept in the
  browser. + New opens a Repo picker ("No Repo" first, then the Repos A→Z, searchable) and, for a Repo, a searchable
  branch picker that marks "checked out", "on origin" and "open PR", where a name typed in offers "Create <name>", a new
  branch from the default one, and Start. A Repo picked in the filter is the one it starts in. "No Repo" needs only Start.
  The branch picked for a Repo is kept. Loading reads "Reading Sessions…"; an error, "Could not read Sessions."; an empty
  list, "No Sessions yet. Start one with + New."; a filter with no match, "No Session in this view."; a search with none,
  "No Session matches “q”." With no Repos: "Import a Repo in Repos to work on its branches."
- Session view: a header in one row holds the Repo's name (or "No Repo"), the title (cut with an ellipsis, the whole
  title in its Tip) and the state on the left, and the Session button on the right, with a dot while a subagent works.
  The state is a pill: tinted and pulsing while a run goes, red when failed. An empty conversation says what to ask:
  "Nothing said yet. Tell the agent what to do on <branch>." in a Repo, and for a Session with no Repo that it works in a
  folder of its own and may clone a repo. The conversation opens at its newest message and follows new and streaming messages while the operator is
  at the end; scrolled up to read, it stays where they left it. A map on its left edge has a mark per message, the operator's
  longer and darker, and tints the marks of the messages in view. Hovering a mark names its message's first line;
  clicking it scrolls there. Scrolled up, a "Scroll to end" button over the bottom edge goes back to the newest
  message. The composer holds the model pill (Model, Effort and Access), Attach files, the other Repos opened to the Session
  (`open-other-repos-to-session`) and Send, which keeps the right end of the row.
  While a run goes, `waiting_input` included, Stop sits before Send and ends it (`02-settings-agents` Behavior 11a).
  Each run of the agent's tool steps folds to one line: the count and the latest step, turning while the message
  streams. Open, each step is one short line, such as "Ran git add +3" for a chain of shell commands; the full
  command shows on hover. A file the agent writes or edits is its own File change row, closed: the file type, the
  name in bold with its full path on hover, "Wrote" (the change removes no line) or "Edited", and `+N −M`. Clicking
  the row, or Enter or Space on it, opens the diff under it and clicking again closes it. A long name shortens in
  the middle and keeps its ending. The diff is not drawn while the row is closed, and a long one scrolls inside the
  row. An open row stays open while the message streams on. Consecutive changes stay consecutive rows.
  Each message the operator sent shows Copy on hover. The last one also shows Edit while no run goes: it opens the
  text in place with Cancel and Revert and rerun (`02-settings-agents` Behavior 8a). A note above the composer then
  names the files put back with their line counts, or says why none were, until closed or the next Send.
  Enter sends and Shift+Enter adds a line. While the agent works the box stays open and Send reads Queue: the
  message waits in a "Queued" note with Send now and Take back, and sends when the run ends. The daemon keeps the
  queued message, so the Agent runs page shows it too (`agent-runs-page` Behavior 13). Send now stops the run and sends
  it at once. When the operator stops the run, the note reads "On hold" and the message does not send until Send now.
  Take back puts it in the box. Its draft is kept per Session.
  Files attach to the next message three ways: the paperclip, dropping them on the box, or pasting them (a
  screenshot, a file copied in Finder). Each uploads at once to `POST /api/sessions/:id/attachments?name=` and is
  saved under a new name in `attachments/<session id>/` in the data folder. Each file is a chip in the text where
  the cursor was (`[📎 name]` in the message, drawn like a `$skill` chip), in the order added; a click opens it and
  Backspace takes it, and its file, out. A pasted long text stays a card in a row above the text, with its first lines
  and an edit button, and so does a file whose upload failed, with the reason and a remove button. Two
  files with one name get `name (2)` and on. Saved files stay with the Session through a reload, a switch of Session or
  tab, until removed or sent. Send waits until every file is saved. The message ends with an "Attached files" list of
  each name, saved path, type and size, and the run lets the agent read that folder, so its Read tool opens them without
  an Approval. A sent message shows each file as a chip under its text; a message sent before the row existed shows a
  file as a chip where it sat in the text. A chip, in the box or in the conversation, opens its file over the page from
  `GET /api/sessions/:id/attachments/:file`: an image or PDF as itself, text as text up to 256 KB, anything else
  with Download.
- A row above the composer reads "Waiting on N subagents" with their descriptions and a Stop while a run waits on
  subagents (`session-panel-and-subagents`).
- Session panel: the right column holds the Session panel, the Diff panel or the Browser panel, one at a time; opening one
  folds the others. The Session panel is open by default, and its width and resize handle are the Diff panel's own
  (`session-panel-and-subagents`). It holds, top to bottom:
  Open in VS Code and a button that shows the folder, both for the Session's worktree on this machine; "Open a surface",
  with Browser (a `:port` badge while a server of the Session listens and no tab shows it), Terminals (the count of
  running processes; it shows or hides the dock) and Diff (once the worktree has changes); the branch picker; the pull
  requests of the Session, newest first, the first three shown and the rest behind "Show N more" and "Show less", each
  with its title, "PR #N →" into the Pull requests tab, "#N on host ↗", its state and its checks mark
  (`session-pull-requests`); Commit, push & PR, a split button whose row does the next step (Commit while files are
  uncommitted, then Create PR when the branch can open one, else Push) and whose menu lists all three (Behavior 34); a
  Changes row with `+N −M` when the branch changed; Servers, this Session's own, each opening in the Browser; "Alert →",
  which opens the Monitor Alert whose Verification or Fix runs in the Session, and "Playbook: <name>"; Lineage, with the
  Session that started this one, the Sessions it started and, under "Previous agents", the subagents of the latest run;
  and Delete, disabled while the Session runs or waits on the operator, with the reason in its Tip. A failed Delete shows
  why. Commit, push and the branch picker give the reason when something blocks them, such as a run going or the default
  branch. An open pull request the Git host lists for the Session's own branch is the first row even when the console did
  not open it. An anonymous Session shows its clone's branch as text, with no picker.
- Browser panel and Terminals dock: a Session that works in a folder, `repo` or anonymous, has them (`session-browser`).
  The panel shows the Session's Chrome tabs beside the conversation. The dock sits under it with its bar of icons, Split,
  Maximize and a process list.
- Diff: on a `repo` Session whose worktree changes something, the Session panel's Diff and Changes rows open a panel right of
  the conversation (Behavior 31). It names the branch and what it is compared with, then lists each file with its status
  letter, path and counts. Files open on their lines while there are 8 or fewer, else folded; each folds on its own,
  and Expand all or Collapse all does every file. Split shows the old and new side by side (Unified goes back), and Refresh
  reads again. The diff is read again as the agent works, at most every 4 seconds, and when a run ends. Dragging the bar
  between the conversation and the panel, or the arrow keys on it, resizes the panel; a double click resets it. The
  conversation keeps at least 360 px beside the Diff or the Browser panel and 480 px beside the Session panel. Open or
  closed, the width and Split are kept.
- Branch switcher: the Session panel's branch chip shows the branch and "changed" or "clean" from the Repo's own folder
  while it is on that branch. Its menu, "Branches in <Repo>", lists branches A→Z with an "open PR" mark and a tick on the
  current one, and a field "New branch from current" with Create. The chip is disabled with the reason ("This Session is
  running." or "A Session in this Repo is running.") while Behavior 7 blocks it. "Uncommitted changes were stashed." shows
  after a checkout that stashed.
- Pull request list (`workspace-inbox-and-pr-cockpit`): flat, grouped by what the operator does next: Changes requested,
  Checks failing, To review (not yours, not approved), Waiting on review (yours) and Ready to merge, in the host's order
  within a group. A group's header folds it, and the folds are kept. A row has two lines: the title and the time since it
  was opened (with `↗` when it opens on the host), then `#number`, the repository's short name (its `slug` in the Tip) and
  the author, followed by `not imported` when no Repo matches, `agent` when `by_agent`, the checks mark (◐ running, ✓ passed,
  ✕ failed), who approved it ("approved") or the review state ("changes"), and the comment count. One line holds the search,
  Mine (the default), Others or All, and Refresh, which reads the Git hosts again. Under Mine the search reads "#, title or your
  email" and matches the number, the title and the Connector's `login`; under All it reads "#, title or author" and matches
  the number, the title and the author. A search stays still for 400 ms before it is sent, and a number shows "Asking the
  Git hosts for #N…" while it waits. Mine, Others or All and the search text are kept. Others reads the same pull requests as All and lists the ones the
  operator did not open. With any pull request listed, a project picker ("All projects", then each repository A→Z) narrow the
  list. A pull request of an imported GitHub or Bitbucket Repo opens in the console; any other opens on the host in a new
  tab. A stale banner reads "The Git host did not answer. Showing what was read at" `synced_at` when `meta.stale` is true.
  Loading reads "Reading pull requests…". An error reads "Could not read pull requests:" and the host's message when the
  host fails with nothing cached. Empty: "No open pull requests of yours." under Mine, "No open pull requests." under All; a
  search that matches nothing reads "No pull requests of yours match “q”." under Mine and "No pull requests match “q”."
  under All; a filter with no match, "No pull request in this view."
- Pull request page: the header holds `#number` and the title. Under it sit the author's initials, branch → base, the state
  when not open, then the number, author, time since opened, `+N −N` and "Open on the host ↗". While the pull request is
  open, the actions sit on the right: Agent Review, Approve, Merge and a More actions menu (⋯) with Request changes.
  Approve and More actions are hidden on a pull request that `is_mine`. Request changes opens a "What needs to change"
  field under the header with Cancel and Send, whose text is kept. Merge is enabled only when approved and while no file
  conflicts with the base, and asks "Merge #N on the host?" with Merge and Keep open. A merged or closed pull request shows
  its state and no actions. Agent Review reads "Starting…" while the request is out, and is greyed, reading "Agent
  reviewing…", while a review Session is not submitted ("A Session is already working on this" in its Tip), and
  "Reviewed at this commit" while the latest review is of the current head. Pressing it opens "Agent Review": an optional
  note for the agent and Start, which opens the new PR action Session as New Session does. A refused start shows its
  message under the header.
- Three tabs sit under the header: Overview, Files changed and Commits, the last two with their counts. The tab is kept.
  Overview shows the conflict box when there is one, the Description (it folds; "No description." when empty) and
  Activity: the box that comments on the pull request ("Comment on the pull request", with Comment), then the comment
  threads. With none: "No comments yet. Open Files changed, hover a line and press + to comment on it." Files changed shows
  the files under their totals, with Expand all and Collapse all beside them when there is more than one file and the
  count of files viewed; a file that conflicts says `conflict` on its header. Commits lists the branch's commits newest
  first: message, author, age and the short hash, which opens the commit on the host. The conflict box (Behavior 32) names
  each conflicting file, which opens in Files changed when it is in the diff, and gives the git commands to resolve them on
  the branch. With `checking` the Merge readiness item reads "Checking for conflicts", and with `unknown`, "Conflicts not
  known".
- A sidebar on the right stays in view while the page scrolls. Each section folds, and a fold holds on every pull request.
  The sections are Checks; Merge readiness, "N of M merge checks passed" for approval, checks, conflicts (an open pull
  request), open threads and the agent review ("Agent reviewing", "Not reviewed by the agent", "New commit since the agent
  review" or "Agent reviewed this commit"); People, the author and who approved; Threads; and Sessions.
- Threads reads "N threads open · M resolved". Address comments shows on an open pull request with at least one unresolved
  thread, the operator's or someone else's, on a line, on a file or on the pull request itself. It opens a list of every
  unresolved thread with all ticked, each as its place (`file:line` or "General comment"), its author and its first line,
  and Start, which needs at least one ticked, and Cancel. Check replies shows below it with `· N`, the threads it covers; it
  does not show when there are none, unless a Check replies Session is not submitted. With neither: "Nothing for the agent
  to address." While a Session of the action is not submitted its button is disabled with "A Session is already working on
  this". Start opens the new Session.
- Sessions reads "Sessions on <branch>:". It lists each PR action Session as its action (Address comments, Check replies
  or Agent Review) and its state (working, not submitted or submitted), with the pushed commit's short id linked to the
  host and "older commit" when the head moved past it, then each `repo` Session on the pull request's branch with its
  state, or "none". New Session, on an open pull request, starts a `repo` Session on that branch (`from_origin: true`) and
  opens it, its draft reading "On pull request #N (title): " for the operator to say what to change. A failed start shows
  why.
- The page has no Agent Review card, comment pass card or reply strip. A review's findings and verdict are comments on the
  host, and the Session that wrote them is in Sessions.
- The description and every comment are drawn as Markdown (headings, lists, tables, code). Agent comments are marked
  `agent`. A thread on a line or a file has Resolve or Unresolve, and every thread has "Reply…". A comment the operator or
  the agent wrote has a ⋯ menu with Delete, which asks "Delete this comment from the pull request? It cannot be undone."
  before it deletes the comment on the host. ⌘ or Ctrl+Enter sends a comment, and Escape closes a line's box. Each box keeps
  its draft per pull request, thread, or file and line, until it is sent or cancelled.
- A changed file reads as a unified diff: added lines green, removed lines red, hunk headers blue, old and new line
  numbers. Hovering an added or unchanged line shows a `+` that opens a comment box under it; posting sends an inline
  comment on that new-side line. Threads on a line sit under it. Its header folds it and shows how many threads sit
  on the file and `+N −N` with a five-block bar. With more than one file, the Files header has Expand all and Collapse all, which open or fold every file at once and are kept like a file's own fold. Viewed marks the file and folds it; the Files header counts viewed
  files. The browser keeps the marks per pull request, and a mark clears when the file's patch changes. The file's ⋯
  menu switches to side by side or to the entire file (Behavior 25), and opens the file at `head_sha` on the host;
  line comments are in the unified view only. Each file's fold, side by side and entire file are kept. A file with no
  text diff reads "No text diff: binary, renamed or too large."; the entire file of one deleted at `head_sha` reads
  "The file is deleted at this commit."

## Rejected

- **Caching pull requests in the database**: drifts when someone approves or comments on the host directly. The memory cache covers reloads.
- **A composer on the pull request view**: Sessions own the composer. The operator talks to the agent on a PR in a PR action Session, or by replying in a thread it started.
- **Marking agent comments with a hidden tag in the body**: Bitbucket does not hide HTML comments. `agent_comments` works the same on every host.
- **Reading host reactions**: only the likes button needs them, and it differs per host.

## Glossary

- **Git host**: The service holding a Repo's remote: GitHub, GitLab or Bitbucket.
- **Agent Review**: The record of a review a PR action Session submitted: a verdict, findings and a full report, tied to the commit it read and the target branch commit it compared with. Each finding is also posted to the host as a comment. A newer commit makes it stale.
- **Session** (changed): One conversation between the operator and the agent. It runs in one Repo on one branch, in a Session worktree, except a dev-tools Session and an anonymous Session, which have no Repo. A pull request has its own Session for the agent's replies in threads, with no composer, and a PR action Session for each press of one of its three buttons.
- **PR action Session**: A Session the console opens from Address comments, Check replies or Review with agent, in a detached worktree at the pull request's head commit. It ends in one console tool call that posts to the Git host as the operator.
- **Anonymous Session**: A Session with no imported Repo. It works in a folder of its own in the data directory, and the agent may clone a repository into it.

## Seams

- **Backend + SQLite, over HTTP** (`backend/test/workspace.test.ts`: Supertest, temporary data directory, fakes for the Git host adapter, git and the agent runtime): 1 to 5, 7, 9 to 15, 17, 20 to 29, 31 and 32. The Bitbucket adapter against a fake `bkt`.
- **Backend + SQLite, over WebSocket**: 6, 8, 19, 30. Triggers through HTTP, asserts `session.updated`, `pull_request.*` events and the Action Log rows.
- **PR action Sessions** (`backend/test/pr-actions.test.ts`: a fake Git host, a local bare remote that receives the push): 16, 16a, 18.
- **Commit and push** (`backend/test/session-commit-push.test.ts`): 34. **Session pull requests** (`backend/test/pull-request-opening.test.ts`): 33.
- **Browser** (`frontend/e2e/workspace.spec.ts`, `session-card.spec.ts`, `session-pull-requests.spec.ts`, `pr-thread-actions.spec.ts`, `open-pull-request.spec.ts`): the screens under UI.

## Out of scope

- Agent runtime, transcripts, generic Session endpoints and the Action Log: `02-settings-agents`.
- Repo import and the branch list itself: `06-settings-repos`.
- The Git host `login` and sign-in: `04-settings-connectors`.
- Fix branches and PRs opened from an Alert: `08-monitor-dashboard`, through the adapter here.
- The GitLab adapter beyond listing: reading, commenting, reviewing and merging merge requests.
- The Browser panel and the Terminals dock: `session-browser`.
- Opening a pull request from a Session: `console-opens-pull-request`.
