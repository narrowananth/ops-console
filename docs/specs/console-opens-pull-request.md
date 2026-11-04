# Console opens the pull request

**Status:** shipped
**Design:** none. Workspace Session header: gains an "Open pull request" button, and a form under the header. A chat run gains a console tool the operator approves. Departs from the design, which has no such control.

## Problem

An agent run cannot push or open a pull request for GitLab or Bitbucket. For GitHub it works only because the run holds `GH_TOKEN`. The Run sandbox blocks `~/.ssh/known_hosts`, the Keychain and each CLI's config folder, and `ssh` ignores the Network allowlist's proxy. The agent tries, fails and tells the operator to paste the pull request description by hand. No sandbox rule fixes it: `bkt` keeps a short-lived OAuth token in the Keychain and refreshes it itself, so a copy handed to a run expires mid-run.

The console already pushes and talks to every Git host outside the sandbox, signed in as the operator through the Connectors (ADR 0005). The agent should commit and write the text; the console should push and open the pull request, the same way for GitHub, GitLab and Bitbucket.

## Behavior

### Who does what

1. An agent run commits the work and writes the pull request's title and description. It never pushes and never opens a pull request itself, in any Session kind and any Access mode. Its prompt says so, and says the console does it when the agent asks through the console's `open_pull_request` tool (Behavior 12).
2. The console pushes the branch to `origin` and opens the pull request on the Repo's Git host. Both run in the daemon, outside the Run sandbox, as the operator: the push uses the Repo's own `origin` remote and keys, the pull request uses the Connector's CLI (`gh`, `glab` or `bkt`). Same steps for all three hosts.
3. The console never forces a push and never merges (ADR 0002).

### Fix

4. The Fix's pull request stage asks the agent for the description only. The console then pushes the Fix branch and opens the pull request titled as before (the Jira key, when there is one, then the Alert's title). The operator's confirmed Report is the approval; the stage needs no further click.
5. A push refused because the branch moved on origin ends the stage `failed` with "Branch moved on origin: nothing was pushed". The console opens nothing and does not retry on its own. The operator retries the Fix's stage as today.
6. A Git host whose Connector is not connected ends the stage `failed` with "GitHub is not connected" (or GitLab or Bitbucket), before anything is pushed. A retry opens the pull request. A pull request the host already has for the branch is returned, not opened twice.
7. The Fix's remaining steps, the Jira move to in review, the `pr_open` status and the merged or closed follow-up are unchanged.

### Chat Session (Workspace)

8. A Session on a Repo whose Git host is GitHub, GitLab or Bitbucket shows an "Open pull request" button in its header when its branch is not the Repo's default branch, has commits origin's base branch lacks, and has no open pull request. A Repo with no remote, or a local Repo, shows no button. Changes not yet committed are not part of the pull request; the form says so when there are any.
9. The button opens a form under the header with a title, a description and a base branch. An agent turn in the same Session fills the title and description from the Session's diff, following the pull request description rule. While it runs the form shows a placeholder and the fields are read-only. If the turn fails or does not answer as asked, the fields start empty and the operator can write them.
10. The base branch starts as the Repo's default branch. The operator may change it to any branch origin has.
11. The operator edits the fields and confirms. The console pushes, opens the pull request and shows its number and link in the Session header, replacing the button. The Session's pull request list refreshes.
12. Asking the agent in chat to "create a PR" makes it call the `open_pull_request` tool with a title and a description. The tool is offered only to a Session in a Repo, in the Repo's own folder, on a supported Git host. Before it runs, an Approval asks in every Access mode, `full` included: "Push <branch> and open a pull request into <base> on <host>: <title>". Nothing is pushed before the yes. A yes has the console push and open it, as the button does, and the tool answers the agent with the link. A no pushes and opens nothing, and the agent is told not to retry. A call that cannot open anything (the default branch, no new commits, no supported host) is refused before the Approval, with the reason. The branch is the one checked out in the Repo's folder unless the agent names another, and the base is the Repo's default branch unless it names another. A run with no such tool, such as an anonymous Session or one in a scratch copy, says the operator opens it with the button or pushes by hand.
13. Every push and every pull request opening writes an Action Log row first and finishes it `ok` or `failed`, with the failure reason.
14. Two clicks at once, or two browsers, open one pull request. The second confirm finds the open pull request and shows it, with no error and no duplicate.
15. A reload mid-draft closes the form; the button is there to start it again. A reload after confirm shows the link.

### Sandbox

16. No run reads `~/.ssh`, a Fix included. The Run sandbox denies it for every kind.
17. A run's Network allowlist is unchanged. The host of each Repo's `origin` stays in From Repos: a run may still `git fetch` it over https. The console's push and pull request call are not filtered, since they run in the daemon.

### What must not regress

18. A pull request already open for the branch is never duplicated by a Fix retry.
19. Agent Review, Reply check and Comment pass still deny `git push` and the host CLIs' write commands.
20. `GH_TOKEN` still reaches a run, as before. It is no longer needed to open a pull request.

## Settled

- **Mechanism**: the console pushes with `git` and opens with the Git host adapter, both in the daemon. No token goes into a run. No ssh from a run.
- **Why not a token in the run**: `bkt` has no token export and keeps a 2-hour OAuth token in the Keychain; `glab` was not checked. A copy would expire or need a second sign-in.
- **Push command**: the existing never-force push of the Session's HEAD to `origin`. `ssh` remotes work because the daemon is not sandboxed.
- **Host adapters**: each gains "open a pull request": title, description, head branch, base branch, answering the number and link. GitHub through `gh`, GitLab through `glab`, Bitbucket through `bkt`. A pull request already open for the head branch is returned in place of a new one.
- **Operator click in chat, none in Fix**: ADR 0002. A Fix starts only after the Report is confirmed; a chat Session has no such gate, so the button is the gate.
- **Agent's request**: the console's own in-process MCP server `ops-console`, with one tool, `open_pull_request` (title, description, optional base and branch). The Approval is raised by the run's PreToolUse hook, which runs in every Access mode, so `full` asks too. It is an ordinary `command` Approval; the Action Log rows come from the push and the opening themselves.
- **Draft turn**: a normal agent run in the Session. It reads the Session's diff, writes JSON with a title and a description and changes nothing.
- **Host cannot be read**: the Session header treats it as no open pull request and offers the button; a click finds the open one, so none is duplicated.
- **Uncommitted changes**: left out and named in the form. The console does not commit for the operator.
- **`gh` sign-in via `GH_TOKEN`**: stays. Other `gh` uses in a run still need it.

## Not required

- **The agent opening a pull request on its own**: it asks, and the operator approves. The button stays as the manual path.
- **Pushing from a run over ssh or https**: still fails or stays blocked. Review flags code that tries to make it work.
- **A commit made by the console** for uncommitted changes.
- **Finding the open pull request past the host's first page** (50 on GitHub and Bitbucket, 100 on GitLab): a branch whose pull request sits beyond it is opened again, and the host refuses the duplicate.
- **Draft pull requests, reviewers and labels** in the form.
- **Opening a pull request on another remote** than `origin`.

## Safety

The agent's reach shrinks, with one addition. A run loses `~/.ssh` in a Fix and loses the instruction to push and open pull requests. A chat run gains one tool that can push its branch and open a pull request, and the tool runs only after the operator approves each call. The push and the opening run in the daemon, never with force, and only after the Report's confirmation (Fix), the operator's click or the operator's Approval (chat). A run steered by a log line can ask for a pull request, and the operator sees the branch and title before anything leaves the Mac. The console runs no shell command a run chose. ADR 0002 and ADR 0003 hold. The PROD-write rule is untouched.

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

Runs the draft turn and answers 200 when it ends. The request lasts as long as the agent does.

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

Workspace Session header: an "Open pull request" button, shown by Behavior 8; the pull request's link the header already shows takes its place. The button opens a form under the header with Title, Description and Base branch fields and an Open pull request button.

- **Loading**: the draft turn runs; fields read-only with a placeholder, the button disabled.
- **Empty**: the draft failed; fields empty and editable.
- **Opening**: the button is disabled and reads "Opening…" while the console pushes and opens.
- **Error**: the message under the fields (Common errors), form kept. `connector_not_connected` links to Integrations.
- **Uncommitted changes**: a line under the form names how many files are left out.
- **PROD**: changes nothing here.

## Rejected

- **A token handed to the run, as for GitHub**: `bkt` has no export and its OAuth token lasts about 2 hours. GitLab is unverified. Copies expire or leak.
- **A `bkt` API token the operator types**: breaks ADR 0005 ("the operator types no token").
- **Relaxing the sandbox** (write `~/.ssh/known_hosts`, `~/.config/bkt`, the Keychain): opens the files the sandbox protects, and `ssh` still ignores the proxy.

## Glossary

- **Pull request opening**: the console's push of a Session's branch to `origin` and its call to the Git host to open the pull request, run in the daemon. The agent writes the title and description; it never pushes or opens.

## ADR

- **0006, Agent runs are sandboxed by the OS**: edit in place. `~/.ssh` is denied in every run, a Fix included; "Denying `~/.ssh` in a Fix too" leaves Considered Options because the console now pushes. The Consequences line "a `git push` over ssh does not work" names the console's push as the path.
- **0005, Claude Code is the integration layer**: one added sentence: the console, not the agent, opens pull requests through the Connectors' CLIs.

## Seams

- **Pull request opening** (backend + SQLite, Supertest, a fake Git host adapter, real git against a bare `origin`, the fake SDK recording its options and running the PreToolUse hook; a new test file and the Fix tests in Monitor): 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 18.
- **Run sandbox options** (backend, fake SDK that records options, and the real-sandbox test): 16, 17.
- **Browser** (Playwright with the daemon's answers scripted; a new spec): 9, 10, 11, 15.
- **Unchanged code, pinned by the existing tests** (the Agent Review, Reply check and Comment pass deny lists; the `GH_TOKEN` run env): 19, 20.

## Out of scope

- A console-made commit for uncommitted changes. Goes in its own spec if the form's note is not enough.
- Draft pull requests, reviewers, labels and a second remote.
