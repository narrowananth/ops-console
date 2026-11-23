# Console opens the pull request

**Status:** shipped
**Design:** none. The Session panel's Commit, push & PR row has a Create PR step that opens a dialog, and `/pr` in the composer opens the same dialog. A chat run gets the console tool `open_pull_request`, which asks for no Approval (ADR 0002). Departs from the design, which has no such control.

## Problem

An agent run cannot open a pull request for GitLab or Bitbucket. For GitHub it works only because the run holds `GH_TOKEN`. The Run sandbox closes the Keychain, where `gh`, `glab` and `bkt` keep their sign-in, and `bkt` keeps a short-lived OAuth token there and refreshes it itself, so a copy handed to a run expires mid-run.

The console already pushes and talks to every Git host outside the sandbox, signed in as the operator through the Connectors (ADR 0005). The agent should commit and write the text; the console should push and open the pull request, the same way for GitHub, GitLab and Bitbucket.

## Behavior

### Who does what

1. An agent run commits the work and writes the pull request's title and description. It never pushes and never opens a pull request itself, in any Session kind and any Access mode. Its prompt says so, and says the console does it when the agent calls the console's `open_pull_request` tool (Behavior 12).
2. The console pushes the branch to `origin` and opens the pull request on the Repo's Git host. Both run in the daemon, outside the Run sandbox, as the operator: the push uses the Repo's own `origin` remote and keys, the pull request uses the Connector's CLI (`gh`, `glab` or `bkt`). Same steps for all three hosts.
3. The console never forces a push and never merges (ADR 0002).

### Fix

4. The Fix's pull request stage asks the agent for the description only. The console then pushes the Fix branch and opens the pull request titled as before (the Jira key, when there is one, then the Alert's title). The operator's confirmed Report is the approval; the stage needs no further click.
5. A push refused because the branch moved on origin ends the stage `failed` with "Branch moved on origin: nothing was pushed". The console opens nothing and does not retry on its own. The operator retries the Fix's stage.
6. A Git host whose Connector is not connected ends the stage `failed` with "GitHub is not connected" (or GitLab or Bitbucket), before anything is pushed. A retry opens the pull request. A pull request the host already has for the branch is returned, not opened twice.
7. The Fix's remaining steps, the Jira move to in review, the `pr_open` status and the merged or closed follow-up are unchanged.

### Chat Session (Workspace)

8. A Session on a Repo whose Git host is GitHub, GitLab or Bitbucket can open a pull request when its branch is not the Repo's default branch, has commits origin's base branch lacks, and has no open pull request. The Session panel's Commit, push & PR row then offers Create PR (the row's main step once nothing is left to commit), and the composer's `/pr` command appears, unless the Session is working. A Repo with no remote, or a local Repo, offers neither. Changes not yet committed are not part of the pull request; the dialog says so when there are any.
9. Create PR and `/pr` open a dialog with a title, a description and a base branch. The console fills the title and description at once from the branch's commits beyond its base: the first commit's subject, and for one commit its message body, for several a line per commit. No agent run is involved. A branch with no such commits starts with empty fields the operator can write.
10. The base branch starts as the Repo's default branch. The operator may change it to any branch origin has.
11. The operator edits the fields and confirms. The console pushes and checks the base branch on origin side by side, so the branch can be on origin when the base turns out missing; it is never forced. The console then opens the pull request, adds it to the Session's pull request list (`session-pull-requests`) and the Session panel shows its number and link.
12. Asking the agent in chat to "create a PR" makes it call the `open_pull_request` tool with a title and a description. The tool is offered only to a Session in a Repo, in its own worktree, on a supported Git host. It asks for no Approval, in any Access mode (ADR 0002): the console pushes the branch and opens the pull request at once, as the dialog does, and the tool answers the agent with the link. A branch that already has an open pull request gets its new commits pushed and that pull request's link back. A call that cannot open anything (the default branch, no new commits, no supported host) is refused with the reason. The branch is the one checked out in the Session's worktree unless the agent names another, and the base is the Repo's default branch unless it names another. A run with no such tool, such as an anonymous Session (which can move into a Repo first, `anonymous-joins-repo`), says the operator opens it with Create PR or pushes by hand.
13. Every push and every pull request opening writes an Action Log row first and finishes it `ok` or `failed`, with the failure reason.
14. Two clicks at once, or two browsers, open one pull request. The second confirm finds the open pull request and shows it, with no error and no duplicate.
15. A reload mid-draft closes the dialog; Create PR starts it again. A reload after confirm shows the link.
15a. A push whose branch moved on origin, with the branch checked out in the Session's worktree, rebases the commits onto origin's tip and pushes again, never forced. A rebase that conflicts is aborted and ends with `branch_moved` and a message that says nothing was pushed. The Push step of the Commit, push & PR row (`POST /sessions/:id/push`) pushes the Session's branch the same way and opens nothing.

### Sandbox

16. The push and the host call run in the daemon, outside the Run sandbox, with the operator's own git keys and the Connector's CLI. A run's commands could reach the same host, but they hold no Keychain sign-in (ADR 0006).
17. The Run sandbox does not filter the console's push and pull request call.

### What must not regress

18. A pull request already open for the branch is never duplicated by a Fix retry.
19. A PR action Session, a Verification and a Reply in thread deny `git push` and the host CLIs' write commands (`HOST_WRITE_DENIALS`).
20. `GH_TOKEN` still reaches a run. It is not needed to open a pull request.

## Settled

- **Mechanism**: the console pushes with `git` and opens with the Git host adapter, both in the daemon. No token goes into a run. No ssh from a run.
- **Why not a token in the run**: `bkt` has no token export and keeps a 2-hour OAuth token in the Keychain; `glab` was not checked. A copy would expire or need a second sign-in.
- **Push command**: the never-force push of the Session's HEAD to `origin`. `ssh` remotes work because the daemon is not sandboxed.
- **Host adapters**: each gains "open a pull request": title, description, head branch, base branch, answering the number and link. GitHub through `gh`, GitLab through `glab`, Bitbucket through `bkt`. A pull request already open for the head branch is returned in place of a new one.
- **Operator click in the dialog, none in Fix or on the agent's call**: ADR 0002. A Fix starts only after the Report is confirmed. The agent's own call opens the pull request with no Approval, since the pull request is where the operator reviews and the console never merges.
- **Agent's request**: the console's own in-process MCP server `ops-console`, with the tool `open_pull_request` (title, description, optional base and branch). The run's PreToolUse hook only checks the call can open something and allows it. The Action Log rows come from the push and the opening themselves, written as the operator.
- **Draft**: read from `git log` of the branch beyond its base. It changes nothing and takes no job slot.
- **Host cannot be read**: the Session treats it as no open pull request and offers Create PR; a click finds the open one, so none is duplicated.
- **Uncommitted changes**: left out and named in the form. The console does not commit for the operator.
- **`gh` sign-in via `GH_TOKEN`**: stays. Other `gh` uses in a run still need it.

## Not required

- **An Approval for the agent's request**: the agent's call opens the pull request at once. Create PR stays as the manual path.
- **Stopping a run from pushing**: the run's commands reach origin and `~/.ssh` is readable, so a push from a run can work. The agent is told never to push, and PR action Sessions and Verifications deny `git push`.
- **A commit made by the console inside the pull request dialog.** The Commit step of the Commit, push & PR row commits first.
- **Finding the open pull request past the host's first page** (50 on GitHub and Bitbucket, 100 on GitLab): a branch whose pull request sits beyond it is opened again, and the host refuses the duplicate.
- **Draft pull requests, reviewers and labels** in the dialog.
- **Opening a pull request on another remote** than `origin`.

## Safety

The agent's reach shrinks, with one addition. A run loses the instruction to push and open pull requests. A chat run gains one tool that can push its branch and open a pull request. The push and the opening run in the daemon, never with force, after the Report's confirmation (Fix), the operator's click (Create PR) or the agent's call (chat). A run steered by a log line can ask for a pull request on its own branch; the operator reviews it there, and the console never merges. The console runs no shell command a run chose. ADR 0002 and ADR 0003 hold. The PROD-write rule is untouched.

## API

### Common

Errors:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 404 | `not_found` | The Session does not exist |
| 409 | `invalid_state` | The Session has no Repo with a supported Git host, is on the default branch or has no commits to open |
| 409 | `branch_moved` | Origin's branch has commits the push lacks |
| 409 | `connector_not_connected` | The Git host's Connector is not signed in |
| 400 | `validation_failed` | The title is empty, or the base branch is not on origin |
| 502 | `upstream_failed` | The push or the host call failed; the message is git's or the CLI's first line, with no secret |

### `GET /sessions/:id/pull-request`

What the header needs.

```json
{
  "can_open": true,
  "pull_request": { "number": 123, "url": "https://example.com/org/repo/pull/123" },
  "base_branch": "main",
  "uncommitted_files": 0
}
```

- `can_open`: Behavior 8. `pull_request`: the open one for the branch, or null.
- `base_branch`: the Repo's default branch. `uncommitted_files`: Behavior 8's count, 0 unless the branch is checked out.

### `POST /sessions/:id/pull-request-draft`

Reads the commits and answers 200 at once.

```json
{ "base_branch": "main" }
```

Answers `{ "title": "string | null", "description": "string | null" }`; both null when the turn failed. `session_busy` (409) while the Session's run is going.

### `POST /sessions/:id/pull-request`

Pushes and opens.

```json
{ "title": "string", "description": "string", "base_branch": "main" }
```

Answers 201 with the pull request, or 200 with the same body when one is already open for the branch:

```json
{ "number": 123, "url": "https://example.com/org/repo/pull/123" }
```

Errors: Common.

## UI

Session panel: the Commit, push & PR row (Commit, Push, Create PR) and the composer's `/pr` command, shown by Behavior 8. Create PR opens a modal dialog titled Open pull request with Title, Description and Base branch fields, Cancel and an Open pull request button. The Session's pull request list shows the result.

- **Loading**: the commits are read; fields read-only with the placeholder "Reading the commits…", the button disabled.
- **Empty**: no commits to draft from; fields empty and editable.
- **Opening**: the button is disabled and reads "Opening…" while the console pushes and opens.
- **Error**: the message under the fields (Common errors), form kept. `connector_not_connected` links to Integrations.
- **Uncommitted changes**: a line in the dialog names how many files are left out.
- **PROD**: changes nothing here.

## Rejected

- **A token handed to the run, as for GitHub**: `bkt` has no export and its OAuth token lasts about 2 hours. GitLab is unverified. Copies expire or leak.
- **A `bkt` API token the operator types**: breaks ADR 0005 ("the operator types no token").
- **Opening the Keychain to the run**: gives the run the sign-in the sandbox protects (ADR 0006).

## Glossary

- **Pull request opening**: the console's push of a Session's branch to `origin` and its call to the Git host to open the pull request, run in the daemon. The agent writes the title and description; it never pushes or opens.

## ADR

- **0006, Agent runs are sandboxed by the OS**: Considered Options holds "Letting a Fix push and open its pull request from the run", with why the console's push won.
- **0005, Claude Code is the integration layer**: one added sentence: the console, not the agent, opens pull requests through the Connectors' CLIs.

## Seams

- **Pull request opening** (backend + SQLite, Supertest, a fake Git host adapter, real git against a bare `origin`, the fake SDK recording its options and running the PreToolUse hook, and the Fix tests in Monitor): 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15a, 16, 17, 18.
- **Browser** (Playwright with the daemon's answers scripted): 8, 9, 10, 11, 15.
- **Existing tests** (the `HOST_WRITE_DENIALS` list; the `GH_TOKEN` run env): 19, 20.

## Out of scope

- A commit made by the dialog itself.
- Draft pull requests, reviewers, labels and a second remote.
