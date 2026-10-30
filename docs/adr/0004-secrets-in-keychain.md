# Secrets in the Keychain

Connection passwords, tokens and service-account keys live in the macOS Keychain, keyed by
Connection id. Postgres holds only the Connection's non-secret fields. Secrets are read at the
moment of use and never reach the database, logs, WebSocket payloads or the browser.

## Considered Options

- **Files in `~/.ops-console/secrets` with mode 600**, as the design shows: simple, but any process
  running as the operator can read them, and they end up in backups.
- **Encrypted column in Postgres**: puts the key next to the data it protects.
