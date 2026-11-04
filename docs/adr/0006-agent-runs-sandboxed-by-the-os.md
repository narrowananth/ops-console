# Agent runs are sandboxed by the OS

Every agent run's shell commands run in the Run sandbox: the Claude Agent SDK's own `sandbox` option, which on macOS
is Seatbelt. A run writes only in its working folder and the temp folders, and reads neither the data folder nor
`~/.aws`, `~/.config/gcloud`, `~/.ssh` or the login Keychain folder. The data folder holds
`runtime.json`, whose session token lets a command call the console's own API as the operator, Approvals included. The
console sets the rules and leaves the profile to the SDK. It fails a run when the sandbox is unavailable, never runs a
command outside it, and has no Setting to turn it off. The Setup agent's terminal is no agent run and is not sandboxed.

A run's commands reach only its Network allowlist, which the SDK's filtering proxy enforces (`network.allowedDomains`
with `strictAllowlist`). The console builds the list when the run starts: four built-in hosts (`github.com`,
`api.github.com`, `*.githubusercontent.com`, `registry.npmjs.org`), the host of each Repo's `origin`, and the domains the
operator added. A raw IP address, a DNS lookup outside the filter and a client that ignores the proxy settings are
refused. `WebFetch` and `WebSearch` run outside the filter, so every run denies them.

The daemon bounds every Keychain call at 60 seconds and the wait for the version handover at 90, and shows a call
pending past 10 seconds on every page. The native call cannot be cancelled, so an answer that comes late is dropped.

## Considered Options

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

A run steered by log text can still send out what it can read, but only to a host on its Network allowlist. `GH_TOKEN`
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
