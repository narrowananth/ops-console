# SQLite file for console state

The console runs as a daemon on one Mac. It keeps the state only it knows in one SQLite file,
`state.db`, in its data folder. Everything that already has an owner stays there: messages in the
Claude Code transcript, pull requests on the Git host, MCP servers in the `claude` CLI.

## Consequences

There is no offline pull request list, and no message history apart from Claude Code's. Only the
daemon opens `state.db`.

## Considered Options

- **Postgres through Drizzle**: fits a console shared by a team, but needs Docker or a database
  server next to a one-line install. A shared team server is a separate deployment under ADR 0003.
