# Commit hooks run

**Status:** shipped
**Design:** none, no screen changes.

## Problem

A repo's commit hooks (husky, lefthook, pre-commit, a `core.hooksPath` folder) must run inside an agent run on Node, Java,
Rust and Go repos. An agent whose hook fails can commit with `--no-verify` and say the check could not run.

## Behavior

1. A run's commands write the package-tool caches under the home folder (`~/.npm`, `~/.cargo`, `~/go`, `~/.m2`,
   `~/.gradle` and the rest) and reach every registry, since the Run sandbox limits neither writes nor hosts
   ([open-run-sandbox](open-run-sandbox.md)).
2. The sandbox closes the git control files of the working folder (`hooks`, `config`, `config.worktree`, `commondir`,
   `gitdir`), so a run cannot edit a hook to get past it.
3. Every run's system prompt tells the agent to let the repo's commit hooks finish, to fix what they report (run the
   repo's formatter or lint fixer, install the documented dependencies, correct the code, including files that came in
   from a merge), and to commit again until they pass. It tells the agent to find the repo's own commands and run them
   the way the repo does, and never to say a hook or linter cannot run without having run it.
4. A Bash command that skips hooks is refused before it runs, in every Access mode: `--no-verify` on any git command,
   `git commit -n`, `HUSKY=0`, `HUSKY_SKIP_HOOKS=`, `LEFTHOOK=0`, `SKIP=`, and `core.hooksPath` set to `/dev/null` or
   nothing. A flag named inside a quoted commit message does not count. The refusal tells the agent to run the hooks and
   fix what they report.

## Not required

- **Hooks that need a tool the daemon cannot see**: a run finds `node`, `cargo`, `go` and `java` on the PATH the
  daemon started with.
- **Daemon commits**: the console's own commit of the Changes panel and of a PR action Session's worktree skips hooks,
  because the daemon runs `git` outside the run and a worktree may have no installed packages.
- **Cache poisoning**: a run can write a package cache; nothing checks what it wrote.

## Safety

The Run sandbox (ADR 0006) closes the Keychain folder, the installed app and the git control files. A hook runs with
the operator's rights, as any command in a run does.

## Seams

- **Daemon** (`backend/test/run-sandbox.test.ts`, `agent-guards.test.ts`): 1 to 4.
- **Seatbelt** (`backend/test/run-sandbox-real.test.ts`): 2.

## Out of scope

- Running a repo's hooks outside the sandbox.
