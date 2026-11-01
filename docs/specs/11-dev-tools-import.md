# Dev tools: import connections from the machine and from URLs

**Status:** shipped
**Design:** Setup agent (`05-settings-dev-tools`); no new screen

## Problem

Operators already have their databases set up somewhere: a desktop client such as TablePro, TablePlus or DBeaver,
a `~/.pgpass`, the `.env` and `docker-compose.yml` files in their projects, or a config file their team shares at
a URL. Today the setup agent can only take what the operator types, so moving twenty connections means typing
twenty lines. Which clients an operator has differs from one machine to the next, so the console cannot assume
any one of them.

## Behavior

1. In the Setup agent, the operator asks to import ("bring in my local databases", "import from
   `~/work/api/.env`", "add the connections at https://example.com/team.yml"). The setup agent finds the sources,
   lists what it found, asks which to bring in, then tests and saves each Connection as today
   (`05-settings-dev-tools` Behaviors 13 and 16).
2. `read_local_file` reads any text file on the machine, up to 512 KB, and `list_local_folder` lists any folder.
   Neither asks the operator first. A binary file is refused, and a missing path returns `not_found`. A path macOS
   keeps from the daemon is refused with `no permission` in the message (`05-settings-dev-tools` Behavior 19). A
   folder lists at most 500 entries, A to Z. With `pick`, a list of keys, `read_local_file` parses a JSON file of up
   to 32 MB and returns only the part those keys lead to, pretty-printed: `["mcpServers"]` from a `~/.claude.json`
   too big to read whole. A key the file lacks returns `not_found`, and a file that is not JSON is refused.
3. `fetch_url` reads an http or https page as text, up to 1 MB, in 15 seconds at most. Other schemes are refused.
4. Before Claude sees what a file or page holds, the daemon swaps its secrets for `{{secret:<n>}}`, as it does for a
   typed line. That covers the value of any field whose name contains password, secret, token, API key, private
   key, credential, authorization or cookie (in .env, JSON, YAML, TOML, INI and XML shapes), the password of a URI,
   the password on each `.pgpass` line, and a private key block. A field whose name ends in a setting word (mode,
   type, kind, method, source, provider, file, path, name, url, length, expiry, expires), such as
   `credentialModeJson` or `passwordFile`, keeps its value, and so does a value of `true`, `false`, `null`, `none`,
   `yes` or `no`. The tools resolve the placeholders inside the daemon; the secret never
   reaches Claude's transcript.
5. `list_keychain_items` finds items in the operator's macOS login Keychain whose service, account or label holds a
   given text, and returns names only, at most 200. `read_keychain_secret` returns one item's secret as a
   placeholder, after macOS asks the operator to allow it; it waits up to 2 minutes for the answer. An item that is
   not there returns `not_found`, and one the operator denies is refused with "denied". Off macOS, both answer
   `invalid_state`.
6. `list_connections` returns the Connections the console has: name, type, env, Access Level and non-secret
   config. `list_mcp_servers` returns the MCP Servers the accounts and Repos register: name, scope, transport and
   URL, read from the config files without a health check, headers left out. The agent skips a source whose name
   the console already uses.
7. A pasted database URL (`postgres://`, `mongodb+srv://`, `redis://`) gives the type, host, port, database and
   user. Its password becomes a placeholder.
8. `add_mcp_server` registers a remote MCP Server by its URL (`http` or `sse`, user scope), with optional headers
   whose values may hold placeholders. It sends `saved` with target `mcp_server`. The agent then starts the sign-in
   with `authenticate_mcp_server`.
9. A source's name becomes the Connection's name, with each character other than a letter, digit, dot, dash or
   underscore made a dash.
10. When neither the source nor the Keychain holds a password, the setup agent asks for it in the masked field
    (`05-settings-dev-tools` Behavior 14), once for Connections that share a user and host, and the label names
    where it looked, such as "not in TablePro's file or the Keychain".

## Settled

- **Where the agent looks unprompted** on macOS: TablePro (`~/Library/Application Support/TablePro/connections.json`),
  TablePlus, DBeaver (`~/Library/DBeaverData/workspace6/General/.dbeaver/data-sources.json`), DataGrip, pgAdmin,
  MongoDB Compass, RedisInsight, `~/.pgpass`, `~/.my.cnf`, and `.env` or `docker-compose.yml` files in the
  operator's projects. For MCP Servers: Claude Desktop's config
  (`~/Library/Application Support/Claude/claude_desktop_config.json`) and `~/.claude.json`, read with `pick`. The
  list lives in the agent definition; none is required.
- **Reach**: any path, no approval. The operator chose this over approving each read: the agent sees only masked
  text, and only the operator types to it (`05-settings-dev-tools` Behavior 12).
- **No built-in file tools**: the agent still has none (`--tools ""`). Claude Code's own Read would hand it raw
  secrets.

## Not required

- Decoding a client's encrypted password store, such as DBeaver's `credentials-config.json`. The agent asks for
  that password in the masked field.
- Keychain items in the data protection keychain, which `security` cannot read. TablePro keeps its passwords
  there.
- Approving each read or fetch.

## Safety

- A secret in a shape Behavior 4 does not know reaches Claude, and so does one under a name ending in a setting
  word, such as `apiKeyName` holding the key itself. A masked setting would cost more: the agent took TablePro's
  masked `credentialModeJson` for the password.
- `fetch_url` runs from the daemon, so it can reach hosts on the operator's network. Only the operator types to the
  agent.

## API

Setup tools, `POST /terminals/:id/tools/:tool` (`05-settings-dev-tools`):

| Tool                   | Body                                              | Returns                                               |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| `list_connections`     | `{}`                                              | `[{ name, type, env, access, config }]`               |
| `list_mcp_servers`     | `{}`                                              | `[{ name, scope, transport, url }]`; `url` null for stdio |
| `read_local_file`      | `{ path, pick? }`                                 | `{ path, size, truncated, text }`                     |
| `list_local_folder`    | `{ path }`                                        | `{ path, entries: [{ name, kind, size }], truncated }` |
| `fetch_url`            | `{ url }`                                         | `{ url, status, content_type, truncated, text }`      |
| `list_keychain_items`  | `{ filter }`                                      | `[{ kind, service, account, label }]`                 |
| `read_keychain_secret` | `{ kind?, service, account? }`                    | `{ placeholder }`                                     |
| `add_mcp_server`       | `{ name, url, transport?, headers? }`             | `{ added }`                                           |

A path is absolute, or starts at the home folder (`~/.pgpass`, `Library/…`).

## Seams

- **Backend + SQLite, over HTTP** (the fake `claude` CLI, a fake Keychain, a local HTTP server, files in a
  temporary folder): 2 to 6, 8.
- **Unit**: the masking in 4.
- **Agent definition**: 1, 7, 9 and 10 are instructions to the setup agent; no test pins them.
