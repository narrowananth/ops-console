# Claude Code is the integration layer

Every outside system the console reaches is an MCP server or a CLI registered with Claude Code. To
connect one, the console hands off to the provider's own browser sign-in: Claude Code's MCP OAuth,
or the CLI's login (`pup`, `gh`, `glab`, `bkt`, `slashdocs`). The operator types no token and fills no form before
Connect, the way claude.ai and ChatGPT connect. The Connector pane offers Connect, Reconnect and Disconnect,
and Cancel while a sign-in waits; config the console needs keeps its defaults. A secret the console must hold, such as an MCP server's env var, goes to
the Keychain. The console registers servers with `claude mcp add`. Fixed reads, such as a pull
request list or a health check, call the same servers and CLIs directly, with no model turn.
Judgment work runs as agent sessions.

## Consequences

The console depends on each MCP server's tools and on the `claude` CLI's output format. A server
Claude Code cannot run is a server the console cannot use.

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
