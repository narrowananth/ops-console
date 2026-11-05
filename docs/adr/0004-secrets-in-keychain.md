# Secrets in the Keychain

Connection passwords, tokens and service-account keys live in the macOS Keychain under the service
`ops-console`, keyed `connection:<id>`; an MCP Server's env vars are keyed `mcp:<name>`, the GitHub
Connector's `gh` token included; the CLIProxy API key is `cliproxy:api-key`. `state.db` holds only the
Connection's non-secret fields. Secrets are read at the moment of use and never reach the database,
logs, WebSocket payloads or the browser.

Each release is a new signed app, and macOS asks for the login password once per Keychain item an app did not
create. The previous version's app hands its items over when a new version first starts, and the daemon's reads wait
for that; `keychain-owner.json` in the data folder names the app that holds them. The daemon checks that app before it
runs it: a real path inside another version folder, a bundle that passes `codesign --verify --strict`, and the same
bundle identifier as its own. A failed check refuses the handover and the items stay where they are. The check keeps a
planted or damaged bundle from handing the new app items of its own choosing. It does not stop someone who can already
replace the installed app, and it pins no `cdhash`, which changes with every Node.

The exception is the headers of an http or sse MCP Server. Claude Code sends them itself, so it
keeps them in its own config file in plain text. The console cannot hold them while Claude Code
sends them; the add form says so and suggests OAuth instead.

A server that reads its key only from a file path, as Firebase's does with a service-account key,
gets a copy for as long as it runs. The launcher reads the key from the Keychain when the server
starts, writes it to a new private temp folder (mode 700, the file 600), and removes the folder
when the server exits. The Keychain stays the only lasting copy; a launcher killed before it can
clean up leaves the folder for macOS to clear from the temp directory.

## Considered Options

- **Files in `~/.ops-console/secrets` with mode 600**, as the design shows: simple, but any process
  running as the operator can read them, and they end up in backups.
- **Encrypted column in `state.db`**: puts the key next to the data it protects.
- **Keeping file-only servers out of the console**: no key ever on disk, but Firebase could only be
  reached through servers set up by hand outside the console.
- **Refusing secret headers on MCP Servers**: keeps every secret in the Keychain, but blocks servers
  that only take an API key header.
