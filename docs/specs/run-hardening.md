# Agent run hardening

**Status:** shipped. Item 4 and the Network allowlist in item 10 are superseded by [open-run-sandbox](open-run-sandbox.md)
and [ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md); the other items hold, with PR action Sessions in place of
Agent Review, Reply check and Comment pass.
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
3. An Address comments Session commits and pushes only while the worktree's `.git` still names a worktree under the
   Repo's own `.git/worktrees`. Otherwise nothing is pushed or posted and the call fails with "the scratch copy was
   changed outside the console".
4. Superseded by open-run-sandbox. In every Access mode a run's file tools may not read or edit the login Keychain
   folder or the installed app, and may not edit the git control files of the working folder or of an opened Repo. The
   data folder, `runtime.json` included, is readable.
5. Every run denies commands that name a host's pull request merge endpoint or merge mutation, besides the merge
   commands and MCP tools it already denied.
6. A run that holds Git host denials (a Verification, a PR action Session, an answer in a review thread) also denies
   the write tools of the GitHub and GitLab MCP servers, by the verb their names start with (`create_`, `update_`,
   `push_` and so on). Read tools stay.
7. A run on pull request code (a PR action Session, an answer in a review thread) loads only the user's settings: no
   `.claude` settings, hooks, `.mcp.json` servers or CLAUDE.md from the pull request. A Verification on a clone of a
   URL the operator never imported does the same.
8. An agent's answer in a review thread runs read-only: no edit tools and no writable working folder. It also holds the
   Git host denials.
9. The key file of a Connection's MCP Server is written under `mcp-files` in the data folder while the server runs, and
   removed after, not in the user temp folder.
10. Nothing else changes: the Access modes and the Approvals behave as before.

## Not required

- **A complete merge denial**: a run holds `GH_TOKEN`, and the list of merge spellings cannot cover every client. A
  narrower token is the only full answer.
- **MCP tool names the denials do not know**: a tool of the GitHub server whose name starts with none of the listed
  verbs stays callable in a review.
- **A run in the operator's own checkout loading that Repo's settings**: a Repo Session or Fix runs in code the operator
  imported, and still loads its project settings.

## Safety

The agent's reach shrinks. It gains nothing. ADR 0002 and 0006 hold and describe the file tools and the git control
files.
