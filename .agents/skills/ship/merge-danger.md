# Merge Danger

Fills the `pr` body's Merge Danger section for this repo. Replace that section with:

```markdown
## Merge Danger

**Risk:** <low / medium / high>

**Door:** <one-way or two-way>
**Blast Radius:** <one word>
**Error detection:** <good / gaps / n/a>
**Verified:** <unit only / running app>

<bullets: each gap that raises risk, with a file link>
```

## One-way doors

- A Drizzle migration under `backend/src/db/migrations/`. Once applied, it is never edited; a fix
  is a new migration.
- A change to how or where secrets are stored. Existing secrets must still be readable after it.
- A changed REST or WebSocket shape in `shared/`. An open browser tab still holds the old one.
- Anything the agent does outside this repo: a write to a connection, a Slack message, a GitHub PR
  or comment, a Jira ticket.

## Sensitive paths

Blast radius counts as large here, whatever the diff size:

- The terminal and anything that spawns a shell, `claude`, `gh`, `git` or `pup`.
- The agent's permission rules and tool list, and per-connection access levels.
- Connections and secrets: the Keychain adapter, connection strings, MCP server config writes.
- Server binding, the session token and CORS. The server listens on `127.0.0.1` only.
- PROD connections.
- `compose.yaml`, GitHub Actions workflows, and dependency bumps.

Flag anything that widens the agent's reach, lets it act without the operator's approval, exposes
the server beyond `127.0.0.1`, or logs a secret.

## Error detection

If this breaks, the operator should see it in the console before they act on stale or wrong data.
Gaps include a swallowed catch, a panel that shows the last good value without saying it is stale,
and an agent run that fails with no status change.

## Grade

- **high:** a one-way door or sensitive path that no test covers.
- **medium:** any other gap.
- **low:** no gaps.

Verified reads `running app` only when step 4 of `ship` produced evidence; otherwise `unit only`.
