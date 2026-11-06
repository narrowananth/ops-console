# Agent runs are sandboxed by the OS

Every agent run's shell commands run in the Run sandbox: the Claude Agent SDK's own `sandbox` option, which on macOS
is Seatbelt. A run writes only in its working folder, its Session's output folder under the data folder, the temp folders and the package-tool caches under the home
folder (`~/.npm`, `~/.cache`, `~/.cargo/registry`, `~/go/pkg`, `~/.m2/repository`, `~/.gradle`, `~/Library/Caches` and
a few like them), never in a folder on PATH such as `~/.cargo/bin` or `~/go/bin`. It reads neither the data folder (the working folder and the output folder aside) nor
`~/.aws`, `~/.config/gcloud`, `~/.ssh` or the login Keychain folder. The data folder holds
`runtime.json`, whose session token lets a command call the console's own API as the operator, Approvals included. The
console sets the rules and leaves the profile to the SDK. It fails a run when the sandbox is unavailable, never runs a
command outside it, and has no Setting to turn it off. The Setup agent's terminal is no agent run and is not sandboxed.

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
with `strictAllowlist`). The console builds the list when the run starts: the built-in hosts (GitHub, and the package
registries of npm and Yarn, Cargo, Go, Maven, Gradle, PyPI and RubyGems), the host of each Repo's `origin`, and the
domains the operator added. A raw IP address, a DNS lookup outside the filter and a client that ignores the proxy settings are
refused. `WebFetch` and `WebSearch` run outside the filter, so every run denies them.

The daemon bounds every Keychain call at 60 seconds and the wait for the version handover at 90, and shows a call
pending past 10 seconds on every page. The native call cannot be cancelled, so an answer that comes late is dropped.

Commit hooks run in the sandbox too, in any language. The caches and registries above are what husky, lefthook,
pre-commit, Cargo, Go, Maven and Gradle need to start, so a hook finishes instead of failing on a blocked write or host.
The agent is told never to skip a hook, and its `PreToolUse` hook refuses `--no-verify`, `git commit -n`, `HUSKY=0`,
`SKIP=`, `LEFTHOOK=0` and a `core.hooksPath` pointed at nothing.

## Considered Options

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
- **A Setting or an unsandboxed retry**: the escape hatch is what the sandbox removes.
- **Reading `~/.ssh` in a Fix so its PR stage can push**: the first design. `ssh` writes `known_hosts` and ignores the
  proxy, and the GitLab and Bitbucket CLIs keep short-lived tokens in the Keychain, so a run could not open a pull
  request there anyway. The console pushes and opens it in the daemon instead (Pull request opening).
- **A Git host token handed to the run, as `GH_TOKEN` is**: `bkt` has no token export and refreshes its own OAuth token.

## Consequences

A run steered by log text can still send out what it can read, but only to a host on its Network allowlist. A run can
write into the package caches, so it could poison a cached package for a later build; the console does not guard that. `GH_TOKEN`
reaches `api.github.com`, so a steered run can still use it there (`gh gist create`, a push to a repo it controls); no
domain rule stops that. A command to any other host fails with the host named in its result, and the run goes on. The
operator adds the host in Permissions and the next run has it.

The sandbox blocks the login Keychain, so `gh` signs in through that token in place of its Keychain item, and
`enableWeakerNetworkIsolation` lets Go programs check certificates through macOS's trust service. `pup` keeps its
Datadog sign-in in the Keychain and does not work inside a run's shell; the Datadog MCP Server, outside the sandbox, is
how the Playbooks read Datadog. `ssh` and Node's built-in `fetch` ignore the proxy settings and fail in a run, so a run
cannot push. The console pushes and opens every pull request in the daemon, outside the sandbox, as the operator. A late
`set` may still reach the Keychain after its timeout. The Keychain reads of
`mcp-exec` and the Setup agent have their own waits and are not shown.
