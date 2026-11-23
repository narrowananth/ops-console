# Agent runs are sandboxed by the OS, for the Keychain

Every agent run's shell commands run in the Run sandbox: the Claude Agent SDK's own `sandbox` option, which on macOS
is Seatbelt. The sandbox guards the Keychain and what reaches it, and nothing else. Commands write anywhere, reach any
host and `localhost`, start servers and use any Unix socket (Docker's, a database's), as in the operator's own terminal.
A build, a test run or a Testcontainers suite needs no switch and no list. Closed to a run's commands:

- the login Keychain folder (`~/Library/Keychains`);
- the installed app, `~/.ops-console`: macOS may trust its bundled `node` with Keychain items without a prompt;
- the git control files the daemon's own `git` reads outside the sandbox (below), since a `credential.helper` or hook
  written there would run with the Keychain;
- a read-only run's working folder and, for a Session's worktree, the Repo's git folder.

The console sets the rules and leaves the profile to the SDK. It fails a run when the sandbox is unavailable, never runs
a command the agent wrote outside it, and has no Setting to turn it off. One door leads out: the console's
`run_integration` tool (below). The Setup agent's terminal and a Session process (the Terminals dock) are no agent run
and are not sandboxed; neither is the Session's browser page ([ADR 0007](0007-session-pages-and-processes-leave-the-sandbox.md)).

The data folder, `~/.ssh`, `~/.aws` and `~/.config/gcloud` are readable to a run. The data folder holds `runtime.json`,
whose session token lets a command call the console's own API as the operator, Approvals included, so a steered run can
approve its own request. The operator accepted that for a sandbox that never gets in the way of the work.

A Session in a Repo works in its own git worktree under the data folder, so Sessions on different branches never share a
checkout and the operator's folder is never checked out. Its commits, branches and index live in the Repo's git folder,
outside the worktree. The folder's `hooks`, `config`, `config.worktree`, `commondir` and `gitdir`, and the `gitdir`,
`commondir` and `config.worktree` of the worktree's own folder in it, stay closed to writes, as does the `.git` file of a
worktree. The daemon runs `git` in those folders outside the sandbox, so it turns off hooks and `core.fsmonitor` on every
call, and checks a scratch copy is still its own worktree before it commits or pushes there. The operator opens other
imported Repos to a Session from the composer's Repos icon; a run the operator started then works in those checkouts and
runs `git` there, with their git control files closed the same way. The agent never pushes.

The sandbox filters a run's commands, not the agent's file tools, which run in Claude Code's own process. The console
holds those to the same limits with permission rules in `disallowedTools`: no reading the Keychain folder or the
installed app, and no editing the git control files. The file tools write anywhere, as commands do. `WebFetch` and
`WebSearch` are open. No Access mode changes any of this; the Access mode decides which commands ask the operator.

The integration CLIs (`pup`, `gh`, `glab`, `bkt`, `slashdocs`) keep their sign-in where the sandbox hides it, so a run
cannot use them itself. Its `run_integration` tool has the daemon run one outside the sandbox, as the operator, in the
Session's output folder. The agent gives the CLI and an argument list; no shell runs. The console classifies the command
by its words, default deny: a read runs at once, a write (a comment, a create, an update, a mute) raises an Approval in
every Access mode but full unless the operator chose "Don't ask again this Session" for that CLI (kept on the Session until it is deleted, one CLI at a time), and a run that is not the operator's own chat writes nothing. Sign-in, tokens, config, extensions,
aliases, a flag that passes a secret or another server, a merge by any spelling, and every command no list names are
refused. An argument that names a file outside the run's own folders (its working folder, output folder, opened Repos,
temp and tool caches) is refused too, since the CLI runs with the operator's sign-in. The CLI gets its home folder and
PATH and nothing of the daemon's environment; its output is redacted and cut at 100,000 characters; each call is an
Action Log row. The tool exists only in a run that has an output folder.

The daemon bounds every Keychain call at 60 seconds and the wait for the version handover at 90, and shows a call
pending past 10 seconds on every page. The native call cannot be cancelled, so an answer that comes late is dropped.

Commit hooks run in the sandbox too, in any language. The agent is told never to skip a hook, and its `PreToolUse` hook
refuses `--no-verify`, `git commit -n`, `HUSKY=0`, `SKIP=`, `LEFTHOOK=0` and a `core.hooksPath` pointed at nothing.

## Considered Options

- **Writes only in the working folder, a Network allowlist and a Loopback switch**: the first design. It guarded the
  operator's credentials, the data folder and every host a run could send data to. It lost to constant rework: Gradle
  could not bind its lock socket, Testcontainers could not reach Docker's Unix socket, a test needed a host nobody had
  listed, a hook wrote to a cache nobody had opened, and each fix was a new list, switch or Approval. A steered run can
  still send out what it reads, but so can any process the operator runs in their own terminal. What cannot be undone is
  the Keychain, so the sandbox keeps only that. Tight rules return as a switch if a real incident asks for them.

- **Docker or a micro-VM**: strong isolation, but the installer is `curl | sh`, and a run in a container cannot reach
  the host's Keychain-backed CLIs, `pup`, `gh` or the operator's checkout.
- **A hand-written Seatbelt profile**: a `(deny default)` profile also blocks what `node`, `git` and `pnpm` read to
  start, and the SDK already ships a maintained base profile.
- **Commits in the daemon, outside the sandbox**: every hook would work, but a steered run could edit a hook and then
  ask for the commit, which runs the edited hook with the operator's full access.
- **A Setting or an unsandboxed retry**: the escape hatch is what the sandbox removes. `run_integration` is no retry:
  the agent cannot choose a command's sandbox, only ask the console to run a command from a fixed list.
- **A free-form command outside the sandbox with an Approval**: any command could ask, and the operator would read shell
  to judge it. It lost to a list the console classifies, where a read never asks and a write names what it changes.
- **The Keychain token handed to the run, as `GH_TOKEN` is**: `pup` has no token export, and its token writes monitors,
  dashboards and incidents.
- **Reading `~/.ssh` in a Fix so its PR stage can push**: the first design. `ssh` writes `known_hosts` and ignores the
  proxy, and the GitLab and Bitbucket CLIs keep short-lived tokens in the Keychain, so a run could not open a pull
  request there anyway. The console pushes and opens it in the daemon instead (Pull request opening).
- **A Git host token handed to the run, as `GH_TOKEN` is**: `bkt` has no token export and refreshes its own OAuth token.
- **Closing the data folder, so a run cannot read the session token**: it kept Approvals honest. The operator chose a
  sandbox that never blocks the work over that guard.

## Consequences

A run steered by text it read can do what the operator can do in a terminal, short of the Keychain: send the checkout,
attached files and `GH_TOKEN` to any host, read `~/.ssh` and the cloud credentials, reach a database tunnel to PROD on
`localhost` with a credential it can read, start a server others on the network may reach, and call the console's API
with the session token it reads, approving its own Approvals. The PROD write rule, the merge denials, the console's
pushing and the `run_integration` list are the guards that stay. A run can still write into the package caches, so it
could poison a cached package for a later build; the console does not guard that.

A chat run steered by text it read can run any listed read through `run_integration`, as the operator, and see the output:
logs, pull requests, documents. It can ask for a write, and the operator reads the exact command. A listed read that a
CLI later turns into a write, or a new CLI verb that does one, is a gap the lists must catch: unknown `pup` and `slashdocs`
verbs ask, and a `gh`, `glab` or `bkt` command off the list is refused.

The sandbox blocks the login Keychain, so `gh` signs in through that token in place of its Keychain item, and
`enableWeakerNetworkIsolation` lets Go programs check certificates through macOS's trust service. `pup` keeps its
Datadog sign-in in the Keychain and does not work inside a run's shell; the Datadog MCP Server and `run_integration`, both
outside the sandbox, are how the Playbooks and chats reach Datadog, and the run's system prompt says so. `ssh` has no
Keychain item to read in a run, so a run cannot push. The console pushes and opens every pull request in the daemon,
outside the sandbox, as the operator. A late `set` may still reach the Keychain after its timeout. The Keychain reads of
`mcp-exec` and the Setup agent have their own waits and are not shown.
