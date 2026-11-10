# Agent runs are sandboxed by the OS

Every agent run's shell commands run in the Run sandbox: the Claude Agent SDK's own `sandbox` option, which on macOS
is Seatbelt. A run writes only in its working folder, its Session's output folder under the data folder, the checkouts of the Repos the operator opened to the Session (below), the temp folders and the package-tool caches under the home
folder (`~/.npm`, `~/.cache`, `~/.cargo/registry`, `~/go/pkg`, `~/.m2/repository`, `~/.gradle`, `~/Library/Caches` and
a few like them), never in a folder on PATH such as `~/.cargo/bin` or `~/go/bin`. It reads neither the data folder (the working folder and the output folder aside) nor
`~/.aws`, `~/.config/gcloud`, `~/.ssh` or the login Keychain folder. The data folder holds
`runtime.json`, whose session token lets a command call the console's own API as the operator, Approvals included. The
console sets the rules and leaves the profile to the SDK. It fails a run when the sandbox is unavailable, never runs a
command the agent wrote outside it, and has no Setting to turn it off. One door leads out: the console's `run_integration` tool (below). The Setup agent's terminal is no agent run and is not sandboxed.

The operator opens other imported Repos to a Session from the composer's Repos chip. A run the operator started (a chat turn) then
writes and reads those checkouts as it does its working folder, commands and file tools alike, and may run `git` there
(checkout, branch, add, commit). The choice is the operator's click on a Repo the console imported, never a path or the
agent's request, so text injected through a log cannot widen it. The git control files of each opened Repo stay closed as in the
working folder, and the agent still never pushes. Playbook steps, Verifications, Fixes and read-only runs get none.

A Session in a Repo works in its own git worktree under the data folder, so Sessions on different branches never share a
checkout and the operator's folder is never checked out. Its commits, branches and index live in the Repo's git folder,
outside the worktree, so the Session's own runs may write that folder too. The folder's `hooks`, `config`,
`config.worktree`, `commondir` and `gitdir`, and the `gitdir`, `commondir` and `config.worktree` of the worktree's own folder
in it, stay closed, as they were in the shared checkout. A scratch copy gets no git folder: the daemon commits there.

The sandbox filters a run's commands, not the agent's file tools, which run in Claude Code's own process. The console
holds those to the same limits with permission rules in `disallowedTools`: no reading the data folder's secrets
(`runtime.json`, `state.db`, the account folders, the key files of MCP Servers) or the credential folders, and no editing
the git control files. A `PreToolUse` hook also holds the file tools' write paths to the folders the sandbox lets commands write in
(plus the account's Claude Code config folder), in every Access mode. The sandbox denies reading the install folder
`~/.ops-console`, so a command cannot start the app's bundled `node`, which macOS may trust with the Keychain items. A run's commands may not write `.git/hooks`, `.git/config` or `.git/commondir`, nor the `.git`
file of a worktree. The daemon runs `git` in those folders outside the sandbox, so it turns off hooks and `core.fsmonitor`
on every call, and checks a scratch copy is still its own worktree before it commits or pushes there. A MCP Server that
needs a key as a file gets it in a folder under the data folder, which the sandbox denies reading, not the user temp
folder.

A run's commands reach only its Network allowlist, which the SDK's filtering proxy enforces (`network.allowedDomains`
with `strictAllowlist`). The console builds the list when the run starts: the built-in hosts (GitHub, the API hosts of the
Connectors' services (Bitbucket, GitLab, Atlassian, Datadog, Slack, Sentry, Shopify), and the package
registries of npm and Yarn, Cargo, Go, Maven, Gradle, PyPI and RubyGems), the host of each Repo's `origin`, and the
domains the operator added. A raw IP address, a DNS lookup outside the filter and a client that ignores the proxy settings are
refused. `WebFetch` and `WebSearch` run outside the filter, so every run denies them.

The integration CLIs (`pup`, `gh`, `glab`, `bkt`, `slashdocs`) keep their sign-in where the sandbox hides it, so a run
cannot use them itself. Its `run_integration` tool has the daemon run one outside the sandbox, as the operator, in the
Session's output folder. The agent gives the CLI and an argument list; no shell runs. The console classifies the command
by its words, default deny: a read runs at once, a write (a comment, a create, an update, a mute) raises an Approval in
every Access mode, and a run that is not the operator's own chat writes nothing. Sign-in, tokens, config, extensions,
aliases, a flag that passes a secret or another server, a merge by any spelling, and every command no list names are
refused. An argument that names a file outside the run's own folders is refused too, so the tool cannot read what the
sandbox hides. The CLI gets its home folder and PATH and nothing of the daemon's environment; its output is redacted and
cut at 100,000 characters; each call is an Action Log row. The tool exists only in a run that has an output folder.

The daemon bounds every Keychain call at 60 seconds and the wait for the version handover at 90, and shows a call
pending past 10 seconds on every page. The native call cannot be cancelled, so an answer that comes late is dropped.

Commit hooks run in the sandbox too, in any language. The caches and registries above are what husky, lefthook,
pre-commit, Cargo, Go, Maven and Gradle need to start, so a hook finishes instead of failing on a blocked write or host.
The agent is told never to skip a hook, and its `PreToolUse` hook refuses `--no-verify`, `git commit -n`, `HUSKY=0`,
`SKIP=`, `LEFTHOOK=0` and a `core.hooksPath` pointed at nothing.

## Considered Options

- **One checkout per Repo, shared by its Sessions**: the first design, where the run's working folder was the Repo's own
  folder. Sessions on different branches fought over the one checkout: a Session showed another's branch, pull request
  and changed lines, a branch switch refused while any Session in the Repo ran, and code fetched by nobody went stale.
  It lost to a worktree per Session, which costs a fresh checkout with no `node_modules` or `.env` and lets a run write
  the Repo's git folder (hooks and config stay closed).

- **A run writes only in its own Repo's folder**: the first design. A chat that found a fix in another Repo could only
  print a patch and the commands for the operator to run by hand (a branch could not even be created there). It lost to
  the operator opening the other Repo to that Session by a click.

- **Writes only in the working folder and temp**: the first design. A hook that fetches a crate, a Go module or a Maven
  artifact, or starts a pre-commit environment, writes to a cache under the home folder, so it failed, and the agent
  committed with `--no-verify` to get past it. Closed folders that sit on PATH stay closed.
- **Commits in the daemon, outside the sandbox**: every hook would work, but a steered run could edit a hook and then
  ask for the commit, which runs the edited hook with the operator's full access.
- **Docker or a micro-VM**: strong isolation, but the installer is `curl | sh`, and a run in a container cannot reach
  the host's Keychain-backed CLIs, `pup`, `gh` or the operator's checkout.
- **A hand-written Seatbelt profile**: a `(deny default)` profile also blocks what `node`, `git` and `pnpm` read to
  start, and the SDK already ships a maintained base profile.
- **An open network**: a package install or a git fetch needs no list, but a run steered by log text could send out
  whatever it can read, including the checkout, the files the operator attached and `GH_TOKEN`. The allowlist costs
  the operator a list to extend when a run needs a private registry.
- **DNS interception or a proxy in the daemon**: the SDK already filters, and a second filter is code to keep for the
  same result.
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

## Consequences

A chat run steered by text it read can run any listed read through `run_integration`, as the operator, and see the output:
logs, pull requests, documents. It can ask for a write, and the operator reads the exact command. A listed read that a
CLI later turns into a write, or a new CLI verb that does one, is a gap the lists must catch: unknown `pup` and `slashdocs`
verbs ask, and a `gh`, `glab` or `bkt` command off the list is refused.

A run steered by log text can still send out what it can read, but only to a host on its Network allowlist. A run can
write into the package caches, so it could poison a cached package for a later build; the console does not guard that. `GH_TOKEN`
reaches `api.github.com`, so a steered run can still use it there (`gh gist create`, a push to a repo it controls); no
domain rule stops that. The Connectors' API hosts are on every run's list, so a steered run can send out what it reads to Datadog, Slack, Sentry or Atlassian too, but only to their API hosts, never their ingest or webhook hosts. A command to any other host fails with the host named in its result, and the run goes on. The
operator adds the host in Permissions and the next run has it.

The sandbox blocks the login Keychain, so `gh` signs in through that token in place of its Keychain item, and
`enableWeakerNetworkIsolation` lets Go programs check certificates through macOS's trust service. `pup` keeps its
Datadog sign-in in the Keychain and does not work inside a run's shell; the Datadog MCP Server and `run_integration`, both
outside the sandbox, are how the Playbooks and chats reach Datadog, and the run's system prompt says so. `ssh` and Node's built-in `fetch` ignore the proxy settings and fail in a run, so a run
cannot push. The console pushes and opens every pull request in the daemon, outside the sandbox, as the operator. A late
`set` may still reach the Keychain after its timeout. The Keychain reads of
`mcp-exec` and the Setup agent have their own waits and are not shown.
