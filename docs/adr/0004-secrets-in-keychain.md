# Secrets in the Keychain

Connection passwords, tokens and service-account keys live in the macOS Keychain, keyed by
Connection id; an MCP Server's env vars are keyed `mcp:<name>`. `state.db` holds only the
Connection's non-secret fields. Secrets are read at the moment of use and never reach the database,
logs, WebSocket payloads or the browser.

The exception is the headers of an http or sse MCP Server. Claude Code sends them itself, so it
keeps them in its own config file in plain text. The console cannot hold them while Claude Code
sends them; the add form says so and suggests OAuth instead.

## Considered Options

- **Files in `~/.ops-console/secrets` with mode 600**, as the design shows: simple, but any process
  running as the operator can read them, and they end up in backups.
- **Encrypted column in `state.db`**: puts the key next to the data it protects.
- **Refusing secret headers on MCP Servers**: keeps every secret in the Keychain, but blocks servers
  that only take an API key header.
