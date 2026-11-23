# Open Run sandbox

**Status:** shipped
**Design:** none. Permissions: loses the Network allowlist and Loopback rows. Agent runs: loses the refused-hosts box and the Loopback chip.

## Problem

The Run sandbox limited writes, hosts, `localhost` and Unix sockets, so a Gradle build (a lock socket), a Testcontainers suite (Docker's socket), a test that called an unlisted host and a hook that wrote to an unopened cache each failed inside a run. Each fix was another list, switch or Approval, and the operator redid the same setup on every Session. What cannot be undone is the Keychain. The sandbox keeps that and gets out of the way otherwise ([ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md)).

## Behavior

### What a run's commands can do

1. A run's commands write anywhere the operator can write, reach any host, bind and reach any `localhost` port, listen on every address and use any Unix socket, in every Access mode.
2. The agent's own file tools write anywhere. `WebFetch` and `WebSearch` are available to every run.
3. Gradle, Docker-backed tests and a test that starts its own server run in a Session with no setting changed.

### What stays closed

4. A run's commands cannot read the login Keychain folder (`~/Library/Keychains`) or the installed app (`~/.ops-console`).
5. A run's commands cannot write the git control files the daemon's `git` reads outside the sandbox: `hooks`, `config`, `config.worktree`, `commondir` and `gitdir` of the working folder, of each opened Repo and of a Session worktree's Repo git folder, and a worktree's `.git` file.
6. A read-only run (a review of pull request text, an answer in a thread) cannot change its working folder or, for a Session worktree, the Repo's git folder.
7. The agent's file tools cannot read the Keychain folder or the installed app, and cannot edit the git control files.
8. The sandbox still applies in every Access mode, and a run still fails with the reason when it is unavailable.
9. Merge denials, the PROD write rule, `run_integration`'s list and Approvals, and the console's own pushing do not change.

### What goes away

10. Permissions has no Network allowlist row and no Loopback row, and no daemon route or table keeps either. The Setting `run_sandbox_loopback` is no longer read.
11. A run no longer keeps the hosts the sandbox refused, so the Agent runs page has no refused-hosts box, no Allow and Retry button and no Loopback chip.
12. A run that ends on a network error says the command could not reach a host and offers Retry; it names no host to allow.

### What must not regress

13. The Keychain timeouts, the `GH_TOKEN` sign-in, commit hooks and the `run_integration` file-argument check behave as before.
14. Closing the data folder is no longer part of the sandbox: a run can read `runtime.json` and call the console's API as the operator. ADR 0006 and ADR 0002 say so.
