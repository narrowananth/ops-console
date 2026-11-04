# Agent runs are sandboxed by the OS

Every agent run's shell commands run in the Run sandbox: the Claude Agent SDK's own `sandbox` option, which on macOS
is Seatbelt. A run writes only in its working folder and the temp folders, and reads neither the data folder nor
`~/.aws`, `~/.config/gcloud` or the login Keychain folder. It reads `~/.ssh` only in a Fix. The data folder holds
`runtime.json`, whose session token lets a command call the console's own API as the operator, Approvals included. The
console sets the rules and leaves the profile to the SDK. It fails a run when the sandbox is unavailable, never runs a
command outside it, and has no Setting to turn it off. The Setup agent's terminal is no agent run and is not sandboxed.

The daemon bounds every Keychain call at 60 seconds and the wait for the version handover at 90, and shows a call
pending past 10 seconds on every page. The native call cannot be cancelled, so an answer that comes late is dropped.

## Considered Options

- **Docker or a micro-VM**: strong isolation, but the installer is `curl | sh`, and a run in a container cannot reach
  the host's Keychain-backed CLIs, `pup`, `gh` or the operator's checkout.
- **A hand-written Seatbelt profile**: a `(deny default)` profile also blocks what `node`, `git` and `pnpm` read to
  start, and the SDK already ships a maintained base profile.
- **A network allowlist**: stops a steered run sending out what it can read, but package installs, git fetches and
  `pup` would need a list the operator keeps. It is a later change.
- **A Setting or an unsandboxed retry**: the escape hatch is what the sandbox removes.
- **Denying `~/.ssh` in a Fix too**: breaks the PR stage's push.

## Consequences

The network stays open. A run steered by log text can still send out whatever it can read, including the checkout and
the files the operator attached, and the `GH_TOKEN` each run carries. The sandbox blocks the login Keychain, so `gh`
signs in through that token in place of its Keychain item, and `enableWeakerNetworkIsolation` lets Go programs check
certificates through macOS's trust service. `pup` keeps its Datadog sign-in in the Keychain and does not work inside a
run's shell; the Datadog MCP Server, outside the sandbox, is how the Playbooks read Datadog. A late `set` may still reach the Keychain after its
timeout. The Keychain reads of `mcp-exec` and the Setup agent have their own waits and are not shown.
