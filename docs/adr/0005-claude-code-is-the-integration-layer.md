# Claude Code is the integration layer

Every outside system the console reaches is an MCP server or a CLI registered with Claude Code, except New Relic's own
API when the operator chooses it (below). To
connect one, the console hands off to the provider's own browser sign-in: Claude Code's MCP OAuth,
or the CLI's login (`pup`, `gh`, `glab`, `bkt`, `slashdocs`). The operator types no token and fills no form before
Connect, the way claude.ai and ChatGPT connect, unless the provider ships no OAuth client a public repo can
bundle. The Connector pane offers Connect, Reconnect and Disconnect,
and Cancel while a sign-in waits; config the console needs keeps its defaults. A secret the console must hold, such as an MCP server's env var, goes to
the Keychain. The console registers servers with `claude mcp add`. Fixed reads, such as a pull
request list or a health check, call the same servers and CLIs directly, with no model turn.
When a server lets any client register, the console may hold an MCP sign-in of its own: Grafana Cloud's, made with the MCP
SDK's OAuth client and kept in the Keychain ([ADR 0004](0004-secrets-in-keychain.md)). Its browser comes back to a
loopback page that lives for one callback, so [ADR 0003](0003-local-only-server.md) holds. When a server will not
register the console, as New Relic's will not, the console may read the sign-in Claude Code stored for it, and never
refreshes it. Both let a Scan call the hosted server's tools with no model turn. Connect also registers the server with
Claude Code, so the agent reaches the same logs through the same MCP server. The second path depends on Claude Code's
private storage and a macOS prompt; the alternative, a model turn for each Scan, costs tokens and varies.
New Relic logs have a second route, for an organization whose administrator turned off New Relic's MCP server, a switch in
New Relic's Feature Control Manager that the console cannot change. The operator may give the console a User API key
(`NRAK-...`), and the daemon calls New Relic's regular API (NerdGraph) itself, over HTTPS to New Relic's documented host for
the chosen Region and nowhere else. The key
lives in the Keychain ([ADR 0004](0004-secrets-in-keychain.md)). Only one route is active at a time: connecting by one
replaces the other. The agent never sees the key: a run reaches New Relic through a read-only NRQL tool of the console's
own `ops-console` MCP server, which the daemon runs with the key. Scans read through the same queries on either route.
Judgment work runs as agent sessions. The agent writes a pull request's text; the console pushes the branch and opens
the pull request through the Git host's CLI, since a run's sandbox cannot reach the operator's keys or sign-ins.
The same limit reaches the agent's own use of those CLIs: a chat run asks the console to run one through its `run_integration` tool, and the daemon runs it as the operator ([ADR 0006](0006-agent-runs-sandboxed-by-the-os.md)).

## Consequences

The key route makes the console depend on NerdGraph's schema as well, and it gives the operator a secret to create and
paste in, which the one-click sign-ins avoid. A User key reaches every account its user can open, and the daemon queries only
the one the operator picked; the docs advise a user with a read-only role. The console never reads the MCP route and the key
route at once.

The console depends on each MCP server's tools and on the `claude` CLI's output format. A server
Claude Code cannot run is a server the console cannot use.

Google Docs, Sheets and Drive are reached through a small MCP server the console ships and registers with Claude Code in
every Claude account: its tools call the products' REST APIs. The console runs Google's sign-in with a client the build ships
and keeps the refresh token in the Keychain; the server mints each call's access token from it. So one Google sign-in serves
every Claude account and CLIProxy, and no Claude config holds a Google token. The cost is a client the project owns, which runs
unverified, with Google's warning screen and a 100-user cap, and tools the console writes and maintains.

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
- **claude.ai's Google connectors**: no client for the project to own, but each belongs to one Claude account, so Auto-switch to
  another account loses the tools, and Claude Code turns them off whenever CLIProxy sends a token.
- **Claude Code's own OAuth for Google's servers, with the shipped client**: the sign-in is kept per Claude account, so each
  account signs in again.
- **Google's remote MCP servers for Docs, Sheets and Drive, behind the console's bridge**: Google maintains the tools, but the
  servers are in Developer Preview and Google asks a billing account on the Cloud project before the API can be enabled, which
  an open-source project cannot ask of everyone who runs it.
- **A typed URL and key for Loki and New Relic, read with `logcli` and `newrelic`**: each needed an install and a key the
  operator had to create and paste in. The hosted servers' browser sign-ins replaced them, and the two CLIs left the
  `run_integration` allowlist.
- **MCP servers and CLIs only, with no direct API client**: kept every integration behind Claude Code, and left New Relic
  unreachable for an organization whose administrator turned off its MCP server. The key route is the one exception because
  New Relic's own API is the only way in there.
- **A model turn for each Scan of a hosted server**: the console could use Claude Code's sign-in with no stored copy, but
  every Scan would spend tokens and read the logs differently each time.
