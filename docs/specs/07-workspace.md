# Workspace: repo Sessions, branches and pull requests

**Status:** shipped
**Design:** Workspace in `design/ops-console.html`: Session list per Repo, the Session view with its branch switcher, the pull request list and the pull request view with comments and Agent Review

## Problem

The operator works with the agent inside a Repo: one Session per piece of work, each on its own branch, and the pull requests that come out of them. They need to switch branches without losing uncommitted work, read and answer PR comments without leaving the console, and get the agent's review of a PR posted where the rest of the team reads it. Pull requests already live on the Git host. The console should show them live, and keep only what the host does not know: Agent Reviews and which comments the agent wrote.

## Behavior

Sessions in a Repo

1. Creating a `repo` Session needs a Repo and a branch. Model, effort and access mode come from the session defaults unless the request sets them (`02-settings-agents`).
2. Sessions in different Repos run side by side. A second message to a Session whose run is still going is refused with `session_busy` (`02-settings-agents`).
3. Removing a Repo that has Sessions asks the operator, in the Repo's row, to keep or delete them. Kept, the Repo
   and its Sessions leave every list, a run still going finishes unseen, and importing the same folder again brings
   back the Repo, its Sessions, Agent Reviews and agent comments. Deleted, they go with the Repo; that waits until no
   Session in it is running (`session_busy`). Either way, Services linked to it lose the link. Without a choice the
   daemon refuses with `repo_has_sessions`.
4. Deleting a Session keeps its branch, its Agent Reviews and the comments the agent posted.

Branches

5. Each branch in the Repo's branch list (`06-settings-repos`) also says whether it has an open pull request.
6. Checking out a branch for a Session stashes uncommitted changes first and says so in the response (`stashed: true`). With `create: true` it makes a new branch from the current one and checks it out. The Session's `branch` follows, and `session.updated` carries it.
7. Checkout is refused with `invalid_state` while the Session is not `idle` or `failed`, and while any Session in that Repo is `working` or `waiting_approval`.
8. Checkout, branch creation and stash each write an Action Log row of kind `git` before they run.

Pull requests

9. Listing pull requests reads the Git host, kept in the daemon's memory per Repo. A list under 60 seconds old is served as is. An older one is served at once while the host is read again in the background; when that read finds a pull request added, gone or changed, `pull_request.refreshed` goes out with them in `changed`, and the next list has it. A pull request's detail is kept the same way for 15 seconds, and a change to it goes out as `pull_request.refreshed` with that pull request. Refresh drops that cache. With nothing kept, the list waits for the host.
10. When the host rate limits or fails on a background read, the kept list comes back with `meta.stale: true` from the next list on. With nothing cached it returns `rate_limited` or `upstream_failed`. The cache is empty after a daemon restart.
11. Posting a comment, a reply or a resolve goes to the host. On failure nothing changes. On success the cache for that PR is dropped.
12. A pull request is `is_mine` when its `author` equals the `login` on the Git host's Connector (`04-settings-connectors`), or when the agent opened it (`by_agent`).
13. Approving or requesting changes on a PR whose `author` equals that `login` is refused with `invalid_state`. Commenting is allowed.
14. `comment_count` counts every comment, replies included. `resolved_count` counts resolved threads.
15. Merging is an operator endpoint. It reads the review state from the host and needs `approved`, else `invalid_state`. It writes an Action Log row of kind `pr` before calling the host. If the host rejects it, the PR stays open and the response is `upstream_failed`.
23. With no `repo_id`, the list covers every repository on each connected host: per owner the host lets the operator read (the GitHub login and its orgs, the Bitbucket workspaces from `/user/workspaces`, the GitLab user and top-level groups), plus the Connector's own workspace or org and the owners of imported Repos. Each owner's list is kept like a Repo's; the owners are kept 10 minutes, an empty or failed answer too. Hosts and owners are read side by side. A pull request whose repository is an imported Repo carries its `repo_id`; any other has a null `repo_id`. Every one carries `host` and `slug`. A Bitbucket workspace is read for its 300 most recently pushed repositories. An owner that fails leaves the rest listed and sets `meta.stale`.

Agent Review and the agent's voice on a PR

16. Starting an Agent Review stores a row with the Repo, PR number and the PR's `head_sha`, and runs the agent in the PR's `pr_review` Session. Starting another adds a row. Starting one on a commit that already has a `ready` review is refused with `invalid_state`; a `failed` one can be retried. The prompt lists the PR's open threads and tells the agent not to repeat what they say. A review whose `head_sha` differs from the PR's current one reads as `stale`. On daemon start, a review left `running` becomes `failed`.
17. A pull request has at most one `pr_review` Session. The backend creates it on the first Agent Review or thread reply. It has no composer: sending it a message is refused with `invalid_state`.
18. When an Agent Review finishes, each finding is posted to the host as an inline comment on its file and line; a finding with no file or line posts as a general comment. An Action Log row of kind `pr` exists before each post. Each comment the host accepts is recorded in `agent_comments`. One failed post does not stop the others; the finding records `post_error`. A finding on a file and line where an earlier review's agent thread is still open is not posted again: its `comment_id` points at that thread.
19. When the operator replies in a thread whose first comment is in `agent_comments`, the reply goes to the host and the `pr_review` Session gets the thread and answers. The answer is posted in that thread with an Action Log row first, and recorded in `agent_comments`. A reply in any other thread does not start the agent.
20. A comment is `by_agent` when it is in `agent_comments`. It is `is_mine` when it is `by_agent` or its author is the host Connector's login. `DELETE /repos/:repo/pull-requests/:number/comments/:comment_id` deletes an `is_mine` comment on the host and its `agent_comments` row, and answers 204; anyone else's is refused with `invalid_state` before the host is asked.

Reading a pull request

24. `approved_by` lists who approved the pull request, as the host names them: GitHub's latest review per reviewer that is `APPROVED`, Bitbucket's participants with `approved`. GitLab lists none.
25. `GET /repos/:repo/pull-requests/:number/file?path=&ref=` answers one file's text at commit `ref`, read from the host. `ref` is a commit id; anything else is `validation_failed`. A file not there at `ref` answers `text: null`.

Anonymous Sessions

21. Creating an `anonymous` Session needs no Repo and no branch. It works in its own folder, `anonymous/<session id>` in the data directory, made when the Session is. The agent may clone into it; the Monitor clones a Service's Git URL into one (`08-monitor-dashboard`).
22. An `anonymous` Session's `branch` is the branch of the clone in its folder, null before there is one. It has no branch switcher. Deleting it leaves its folder.

## Settled

- **Git host adapter**: one interface over `github`, `gitlab`, `bitbucket` and `local`, reached through the hosts' CLIs (`gh`, `bkt`, `glab`), per ADR 0005. Listing and reading PRs is a fixed read with no model turn. `local` has no pull requests. Tests use a fake. GitHub (`gh api`) and Bitbucket Cloud (`bkt api`) do everything; GitLab (`glab api`) lists merge requests only, and the list opens them on GitLab.
- **`by_agent` on a pull request**: a `repo` Session works on the PR's branch. The console keeps no record of who ran `gh pr create`, so the Session is the evidence.
- **Agent Review output**: the agent ends with one JSON block holding `verdict`, `findings`, `checklist` and `tools`. Anything else marks the review `failed` and posts nothing.
- **Starting runs**: the console starts the `pr_review` Session's runs itself. An Agent Review or a thread answer while that Session's run is going is refused with `session_busy`; a thread answer then goes unanswered.
- **Pull request cache**: per Repo and state, in the daemon's memory. Posting, resolving, reviewing, merging and an Agent Review drop the Repo's entries. The branch list reads the open list through the same cache.
- **Aggregate list**: with no `repo_id`, a Repo whose host Connector is not connected is skipped. With a `repo_id` it answers `connector_not_connected`.
- **Pull request identity**: Repo and number for an imported Repo; host, slug and number otherwise. No `pull_requests` or `pr_comments` table.
- **Stored here**: Agent Reviews and the ids of comments the agent posted. Everything else about a PR comes from the host.
- **Session rules in code**: a `repo` Session has a Repo and a branch; a `pr_review` Session has a Repo and a PR number; an `anonymous` Session has no Repo and may have a branch; other kinds have neither. SQLite cannot add these as `CHECK`s to an existing table, so the session service enforces them.
- **Agent Review content**: findings, a PROD readiness checklist, the Connections the agent queried, and a verdict.
- **Reactions**: not read. PR comment likes are dropped from the design.

## Not required

- **Fresh PR data**: a list can be up to 60 seconds old, plus the time its background read takes, or older with `meta.stale` while the host fails. The UI starts the first list read as it opens, so the Workspace finds it kept.
- **PRs offline**: with the host unreachable after a restart, the PR list is an error until the host answers.
- **Thread answers while the daemon is down**: a reply posted on the host directly, not through the console, does not wake the agent.
- **Thread answers during a run**: a reply to an agent thread while the pull request's Session is running gets no answer.

## Safety

- The agent has no merge tool on any host. `.claude/settings.json` denies `gh pr merge`; `/ship` also denies the GitLab and Bitbucket merge commands. The only merge path is the operator's merge endpoint, which needs an approved PR.
- The agent posts on a pull request only after the operator starts an Agent Review, or replies in a thread the agent started. Every post and every git action writes an Action Log row first.

## Database

```sql
ALTER TABLE sessions ADD COLUMN repo_id TEXT REFERENCES repos (id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD COLUMN branch TEXT;        -- repo Sessions: the checked-out branch
ALTER TABLE sessions ADD COLUMN pr_number INTEGER;  -- pr_review Sessions: the PR in repo_id
CREATE INDEX sessions_repo_idx ON sessions (repo_id, last_active_at DESC);
CREATE UNIQUE INDEX sessions_one_pr_review_idx ON sessions (repo_id, pr_number) WHERE kind = 'pr_review';

CREATE TABLE pr_agent_reviews (
  id          TEXT PRIMARY KEY NOT NULL,
  repo_id     TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,                     -- the commit that was reviewed
  status      TEXT NOT NULL DEFAULT 'running',   -- AgentReviewStatus
  verdict     TEXT,
  findings    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings)),   -- [{ severity, file, line, text, comment_id, post_error }]
  checklist   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(checklist)),  -- [{ item, status, note }]
  tools       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tools)),      -- [{ connection, query, result }]
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX pr_agent_reviews_pr_idx ON pr_agent_reviews (repo_id, pr_number, created_at DESC);

CREATE TABLE agent_comments (
  repo_id          TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  pr_number        INTEGER NOT NULL,
  comment_id       TEXT NOT NULL,                -- the host's comment id
  agent_review_id  TEXT REFERENCES pr_agent_reviews (id) ON DELETE SET NULL,  -- null: a thread reply
  posted_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo_id, pr_number, comment_id)
) STRICT;
```

| Enum | Values | Columns |
| ---- | ------ | ------- |
| `AgentReviewStatus` | `running`, `ready`, `failed` | `pr_agent_reviews.status` |
| `FindingSeverity` | `blocker`, `suggestion`, `nit` | `findings[].severity` |
| `PrState` | `open`, `merged`, `closed` | API only |
| `PrReviewState` | `none`, `approved`, `changes_requested` | API only |
| `PrChecks` | `none`, `running`, `passed`, `failed` | API only |
| `PrReviewEvent` | `approve`, `request_changes`, `comment` | API only |

Migration of existing rows: none; existing Sessions get null in the new columns.

## API

### Common

Errors added here:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 409 | `repo_has_sessions` | Removing a Repo with Sessions without `sessions=keep` or `delete` |

`PullRequest`, read from the host: `repo_id`, `number`, `url`, `title`, `author`, `branch`, `base_branch`, `head_sha`, `state`, `review_state`, `approved_by`, `checks`, `additions`, `deletions`, `body`, `opened_at`, `merged_at`, plus `is_mine`, `by_agent`, `comment_count`, `resolved_count`, `agent_session_id` (the `pr_review` Session, or null), `latest_agent_review` (`PrAgentReview | null`, with `stale: boolean`). The detail response adds `files` (`[{ name, additions, deletions, lines: [{ sign, text }] }]`) and `comments: PrComment[]`.

`PrComment`, read from the host: `id` (the host's id), `parent_id`, `author`, `by_agent`, `body`, `file_path`, `line`, `resolved` (thread roots), `created_at`, `reply_count`.

`PrAgentReview`: all `pr_agent_reviews` columns.

### `POST /sessions` (extends `02-settings-agents`)

Adds `repo_id` and `branch`, required for kind `repo`. Kind `anonymous` takes neither, and an optional `title`. `pr_review` is never accepted. Errors: `validation_failed` when a `repo` Session misses either.

### `GET /repos/:id/branches` (extends `06-settings-repos`)

Each branch adds `has_open_pr: boolean`.

### `POST /sessions/:id/checkout`

```json
{ "branch": "string", "create": false }
```

Answers 200 with `{ "data": { "session": "Session", "stashed": false } }`. Errors: `invalid_state` (Behavior 7), `upstream_failed` when git refuses.

### Pull requests

`:repo` is the Repo id.

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /pull-requests` | query `repo_id?`, `state?` (default `open`), `mine?`, `q?` | `PullRequest[]` without detail fields, each with `host`, `slug` and `repo_id` (null when not imported). `meta` adds `synced_at` and `stale` |
| `POST /pull-requests/refresh` | `{ repo_id? }` | 202 `{ "data": { "accepted": true } }`; drops the cache. The outcome comes on `pull_request.refreshed` |
| `GET /repos/:repo/pull-requests/:number` | | `PullRequest` with `files` and `comments` |
| `POST /repos/:repo/pull-requests/:number/comments` | `{ body, file_path?, line?, parent_id? }` | 201 `PrComment` as the host returned it; `upstream_failed` |
| `PATCH /repos/:repo/pull-requests/:number/comments/:comment_id` | `{ resolved }` | `PrComment`; thread roots only |
| `POST /repos/:repo/pull-requests/:number/reviews` | `{ event, body? }` | `PullRequest`; `body` required unless `approve`; `invalid_state` on your own PR (Behavior 13) |
| `POST /repos/:repo/pull-requests/:number/merge` | | `PullRequest`; `invalid_state` unless `open` and `approved`; `upstream_failed` |
| `POST /repos/:repo/pull-requests/:number/agent-reviews` | | 202 `PrAgentReview` in `running` |
| `GET /repos/:repo/pull-requests/:number/agent-reviews` | | newest first |

### WebSocket `pull_request.refreshed`

Server to client, when a refresh ends.

```json
{ "repo_id": "uuid | null", "status": "ok | rate_limited | failed", "changed": [{ "repo_id": "uuid", "number": 0 }] }
```

### WebSocket `pull_request.commented`

Server to client, when the host accepts a comment posted through the console, the agent's included.

```json
{ "repo_id": "uuid", "number": 0, "comment_id": "string", "by_agent": true }
```

### WebSocket `pull_request.reviewed`

Server to client, when an Agent Review ends and its findings have been posted.

```json
{ "repo_id": "uuid", "number": 0, "agent_review_id": "uuid", "status": "ready | failed", "posted": 0, "post_failed": 0 }
```

### WebSocket `session.updated` (extends `02-settings-agents`)

Adds `branch: string | null`.

## UI

- Workspace Session list grouped by Repo. A Repo's header shows its branch, how many Sessions are running, its
  Session count and `+`, and folds the group open or shut; the browser remembers folded Repos. An open Repo lists its
  3 most recently active Sessions, plus any running or picked one, then "Show N more". A row shows title and state on
  one line, with the branch under it when it differs from the Repo's. `+` shows the branch picker and Start; a Repo
  with no Sessions shows them at once. With no Repos: "Import a Repo in Repos to work on its branches."
- A "No Repo" group under the Repos lists anonymous Sessions; its `+` starts one at once. `/workspace?session=<id>`
  opens that Session, which is how the Monitor links to a Fix's Session.
- Branch switcher: lists branches with an open-PR mark; disabled with the reason while Behavior 7 blocks it; a toast when changes were stashed.
- Pull request list: mine and all, grouped by repository A→Z under its host's icon and `slug`, tagged `local` with the Repo's name when imported and `not imported` otherwise. Clicking a repository's header folds or unfolds its pull requests, and Collapse all folds every one; the folded set survives a reload, and a search unfolds every match. A pull request of an imported GitHub or Bitbucket Repo opens in the console; any other opens on the host in a new tab. A stale banner shows `synced_at` when `meta.stale` is true. Error state when the host fails with nothing cached. A search that matches nothing says so with the search text.
- Pull request view: the description in a card and every comment drawn as Markdown (headings, lists, tables, code), files, comment threads with resolve, who approved it, agent comments marked, the latest Agent Review with a stale badge. Approve and request changes are hidden on your own PR. Merge is enabled only when approved. Agent Review is greyed, reading "Agent reviewing…", while the latest review is `running`, and "Reviewed at this commit" while the latest is `ready` and not stale. Hovering an added or unchanged line in the unified diff shows a `+` that opens a comment box under it; posting sends an inline comment on that new-side line. Threads on a line sit under it, with Resolve and Reply. A comment the operator or the agent wrote has a ⋯ menu with Delete, which asks once more before it deletes the comment on the host. Under the thread list, a box comments on the pull request itself.
- A changed file reads as a unified diff: added lines green, removed lines red, hunk headers blue, old and new line numbers. Its header folds it and shows `+N −N` with a five-block bar. Viewed marks the file and folds it; the Files header counts viewed files. The browser keeps the marks per pull request, and a mark clears when the file's patch changes. The file's ⋯ menu switches to side by side or to the entire file (Behavior 25), and opens the file at `head_sha` on the host.

## Rejected

- **Caching pull requests in the database**: drifts when someone approves or comments on the host directly. The memory cache covers reloads.
- **A composer on the pull request view**: Sessions own the composer. The operator talks to the agent on a PR by replying in a thread it started.
- **Marking agent comments with a hidden tag in the body**: Bitbucket does not hide HTML comments. `agent_comments` works the same on every host.
- **Reading host reactions**: only the likes button needs them, and it differs per host.

## Glossary

- **Git host**: The service holding a Repo's remote: GitHub, Bitbucket or GitLab.
- **Agent Review**: The agent's written review of a pull request: findings, a PROD readiness checklist and a verdict, tied to the commit it read. Each finding is also posted to the host as a comment.
- **Session** (changed): One conversation between the operator and the agent. It runs in one Repo on one branch, except a dev-tools Session, which has no Repo. A pull request has its own Session for the agent's replies, with no composer.

## Seams

- **Backend + SQLite, over HTTP** (Supertest, temporary data directory, fakes for the Git host adapter, git and the agent runtime): 1 to 5, 7, 9 to 17, 20, 23. The Bitbucket adapter against a fake `bkt`.
- **Backend + SQLite, over WebSocket**: 6, 8, 18, 19. Triggers through HTTP, asserts `session.updated`, `pull_request.*` events and the Action Log rows.

## Out of scope

- Agent runtime, transcripts, generic Session endpoints and the Action Log: `02-settings-agents`.
- Repo import and the branch list itself: `06-settings-repos`.
- The Git host `login` and sign-in: `04-settings-connectors`.
- Fix branches and PRs opened from an Alert: `08-monitor-dashboard`, through the adapter here.
- The GitLab adapter beyond listing: reading, commenting, reviewing and merging merge requests.
- The terminal panel: `05-settings-dev-tools` owns the terminal WebSocket.
