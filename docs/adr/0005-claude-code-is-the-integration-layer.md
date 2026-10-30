# Claude Code is the integration layer

Every outside system the console reaches is an MCP server or a CLI registered with Claude Code. The
console's forms collect the config, the secret goes to the Keychain, and the console registers the
server with `claude mcp add`. Fixed reads, such as a pull request list or a health check, call the
same servers and CLIs directly, with no model turn. Judgment work runs as agent sessions.

## Consequences

The console depends on each MCP server's tools and on the `claude` CLI's output format. A server
Claude Code cannot run is a server the console cannot use.

## Considered Options

- **Per-service API clients**: each would duplicate the auth and config Claude Code already holds.
- **The agent runs everything**: every refresh would cost tokens and seconds, and results could vary
  between runs.
