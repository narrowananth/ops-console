# Agent run hardening

**Status:** shipped
**Design:** none. No screen changes.

## Problem

The Run sandbox limits a run's shell commands, and the denial lists limit what a run may call. Some paths around them did
not match ADR 0002 and 0006: a run's file tools sat outside the sandbox's file limits, git settings a run could write were
trusted by the daemon's own `git`, runs on pull request code loaded that code's own settings, and a review without a
scratch copy could write in the operator's checkout.

## Behavior

1. A run's commands cannot write `.git/hooks`, `.git/config`, `.git/config.worktree`, `.git/commondir` or `.git/gitdir`
   in the working folder. When the folder's `.git` is a file, as in a worktree, they cannot write it.
2. The daemon's `git` runs no hook and no `core.fsmonitor` program, whatever the repository's config says. A clone URL
   that starts with a dash is not read as an option.
3. A Comment pass commits and pushes only while the scratch copy's `.git` still names a worktree under the Repo's own
   `.git/worktrees`. Otherwise the pass fails with "the scratch copy was changed outside the console" and offers no retry.
4. In every Access mode a run's file tools may not read `runtime.json`, `state.db`, the account folders, the MCP key
   files or the credential folders, and may not edit those or the git control files of the working folder. The data
   folder as a whole stays readable, because scratch copies sit in it.
5. Every run denies commands that name a host's pull request merge endpoint or merge mutation, besides the merge
   commands and MCP tools it already denied.
6. A run that holds Git host denials also denies the write tools of the GitHub and GitLab MCP servers, by the verb their
   names start with (`create_`, `update_`, `push_` and so on). Read tools stay.
7. A run on pull request code (Agent Review, Reply check, Comment pass, a review thread answer) loads only the user's
   settings: no `.claude` settings, hooks, `.mcp.json` servers or CLAUDE.md from the pull request.
8. An Agent Review with no scratch copy step, and an agent's answer in a review thread, run read-only: no edit tools and
   no writable working folder. The answer also holds the Git host denials.
9. The key file of a Connection's MCP Server is written under `mcp-files` in the data folder while the server runs, and
   removed after, not in the user temp folder.
10. Nothing else changes: the Access modes, the Approvals and the Network allowlist behave as before.

## Not required

- **A complete merge denial**: a run holds `GH_TOKEN`, and the list of merge spellings cannot cover every client. A
  narrower token is the only full answer.
- **MCP tool names the denials do not know**: a tool of the GitHub server whose name starts with none of the listed
  verbs stays callable in a review.
- **A run in the operator's own checkout loading that Repo's settings**: a Repo Session or Fix runs in code the operator
  imported, and still loads its project settings.

## Safety

The agent's reach shrinks. It gains nothing. ADR 0002 and 0006 hold and now describe the file tools and the git control
files.
