# Claude Code is the integration layer

Every outside system the console reaches is an MCP server or a CLI registered with Claude Code. To
connect one, the console hands off to the provider's own browser sign-in: Claude Code's MCP OAuth,
or the CLI's login (`pup`, `gh`, `glab`, `bkt`, `slashdocs`). The operator types no token and fills no form before
Connect, the way claude.ai and ChatGPT connect, unless the provider ships no OAuth client a public repo can
bundle. The Connector pane offers Connect, Reconnect and Disconnect,
and Cancel while a sign-in waits; config the console needs keeps its defaults. A secret the console must hold, such as an MCP server's env var, goes to
the Keychain. The console registers servers with `claude mcp add`. Fixed reads, such as a pull
request list or a health check, call the same servers and CLIs directly, with no model turn.
Judgment work runs as agent sessions. The agent writes a pull request's text; the console pushes the branch and opens
the pull request through the Git host's CLI, since a run's sandbox cannot reach the operator's keys or sign-ins.
The same limit reaches the agent's own use of those CLIs: a chat run asks the console to run one through its `run_integration` tool, and the daemon runs it as the operator ([ADR 0006](0006-agent-runs-sandboxed-by-the-os.md)).

## Consequences

The console depends on each MCP server's tools and on the `claude` CLI's output format. A server
Claude Code cannot run is a server the console cannot use.

Google Docs, Sheets and Drive are reached through claude.ai's own Google connectors, which Claude Code loads in an account
signed in with claude.ai. The operator adds each one on claude.ai, where Google's sign-in runs on Anthropic's client; the
console reads whether it is connected and holds no client, secret or token. Claude Code turns claude.ai connectors off when an
API key or CLIProxy sets the credentials, so there a Google Connector reads `auth`.

A service with no browser sign-in that gives the console a token of its own is reached through
Claude Code only. Bitbucket has two: Atlassian's MCP server for the agent, and `bkt` for the
console's own calls, such as the pull request list and the operator's merge. The console holds no Bitbucket token; `bkt` keeps its own in
the Keychain, and macOS asks once before the daemon may read it. GitHub's OAuth needs a registered app and its secret, which a public repo
cannot ship, so GitHub uses `gh`'s device sign-in and the operator enters a one-time code the
console shows.

## Considered Options

- **Per-service API clients**: each would duplicate the auth and config Claude Code already holds.
- **Token and config forms before Connect**: the operator had to create a token on each service and
  paste it in. It lost to the redirect sign-in, which needs nothing typed.
- **The agent runs everything**: every refresh would cost tokens and seconds, and results could vary
  between runs.
- **`gws`, Google's Workspace CLI, for Docs, Sheets and Drive**: one CLI and one sign-in for all three. The operator would
  still bring a Cloud project and `gcloud`, the console would need a `run_integration` entry, and the three could not be
  connected apart.
- **The operator brings their own Google OAuth client**: a Cloud project, two APIs and a form before the first Connect.
- **A Google OAuth client the build ships**: it needs the repo owner's Google Cloud project and consent-screen verification,
  and its secret would ship in the public tarball. claude.ai's connectors run Google's sign-in on Anthropic's verified client.
