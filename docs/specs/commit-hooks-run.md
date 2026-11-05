# Commit hooks run

**Status:** shipped
**Design:** none, no screen changes.

## Problem

A repo's commit hooks (husky, lefthook, pre-commit, a `core.hooksPath` folder) failed inside an agent run on Node, Java,
Rust and Go repos. The Run sandbox blocked the caches and registries those tools use, and the agent then committed with
`--no-verify` and said the check could not run.

## Behavior

1. A run's commands write in its working folder, the temp folders and these package-tool caches under the home folder:
   `~/.npm`, `~/.pnpm-store`, `~/.yarn`, `~/.cache`, `~/.cargo/registry`, `~/.cargo/git`, `~/.cargo/.package-cache`,
   `~/go/pkg`, `~/.m2/repository`, `~/.gradle`, `~/.nuget/packages`, `~/Library/Caches` and `~/Library/pnpm`. No folder
   on PATH is writable, such as `~/.cargo/bin` or `~/go/bin`.
2. Every run reaches the registries of npm, Yarn, Cargo, Go, Maven, Gradle, PyPI and RubyGems besides GitHub
   (`run-network-allowlist` Behavior 7).
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
- **Daemon commits**: the console's own commit of a Comment pass in its scratch copy still skips hooks, because a
  scratch copy has no installed packages.
- **Cache poisoning**: a run can write a package cache; nothing checks what it wrote.

## Safety

Widens the Run sandbox (ADR 0006, rewritten). Reads of the data folder, `~/.ssh`, `~/.aws`, `~/.config/gcloud` and the
Keychain folder stay denied.

## Seams

- **Daemon** (`backend/test/run-sandbox.test.ts`, `agent-guards.test.ts`): 1 to 4.
- **Seatbelt** (`backend/test/run-sandbox-real.test.ts`): 1.

## Out of scope

- Running a repo's hooks outside the sandbox.
