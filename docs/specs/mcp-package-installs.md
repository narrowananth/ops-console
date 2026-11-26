# MCP package installs

**Status:** shipped
**Design:** none

## Problem

A Connection's check sometimes shows Failing for minutes with `Cannot find module 'iconv-lite'` or `Cannot find module 'es-abstract/2024/Number/toString'`, on a MongoDB or Firebase Connection, and heals later with no change by the operator. These servers start through `npx -y <package>@latest`, which keeps one folder per package spec in the npm cache. When a new release or a cache refresh rewrites that folder, a start that overlaps it, from the periodic probes, the Connection checks or an agent run, can read a half-written `node_modules` and die. Nine Postgres Connections start the same package, so overlaps are common.

## Behavior

1. A server started with `npx -y <package>@latest` or `npx <package>` runs from an installed version under `mcp-packages/<package>/<version>/` in the data folder. The same holds for `mcp-exec` and for the Connection check, so a check starts what a run starts. Any other command (`uvx`, `pup`, `ops-console google-mcp`) starts as before.
2. A start uses the version `current.json` names, with no network. The server's file is the package's `bin` (a string, else the entry named like the package, else the first), run directly with the arguments after the package.
3. With no install yet, the first start installs under a lock folder shared by every process. A second start waits for the lock, then finds the finished install and does not install again.
4. A version folder is built in a temporary sibling and renamed into place, then never changes. An install that fails or is killed leaves no version folder and no `current.json`; the next start installs again.
5. A lock held by a dead process, or for over 10 minutes, is taken over.
6. Once `current.json` is over 24 hours old, the next start refreshes it in the background: it asks npm for the newest version, installs it into a new folder and then switches `current.json`. Servers already running keep their folder. It asks at most once a day across processes, also when it fails.
7. Version folders older than the newest two are removed, only by the process that holds the lock.
8. When npm is missing, the registry is unreachable with nothing installed, the package has no `bin`, or the lock stays held for 120 seconds, the start runs `npx -y <package>@latest` as before.
9. A server that exits within 10 seconds with `MODULE_NOT_FOUND` or `Cannot find module` on stderr has its install removed, the version folder, or for the `npx` fallback the `_npx/<hash>` folder the error names, and is started once more. A second failure is the result. `mcp-exec` passes stderr through unchanged while it reads it; stdin and stdout stay shared with the MCP protocol.
10. The Connection check and the Keychain handling are unchanged: secrets reach the server process only.

## Settled

- **Where**: `mcp-packages` in the data folder, next to `mcp-files`.
- **Newest two**: `current` and the newest other version, by folder age.
- **Package forms**: only `-y <package>@latest` and `<package>` are ours. A pinned version, `--package` and a path start as before.
- **Refresh clock**: `current.json` holds `checkedAt`, written before npm is asked.

## Not required

- **Latest on the first day**: a start uses the installed version for up to a day after a release.
- **A lock that never double-installs**: two processes that take over one stale lock at once may both install. Each build is renamed into place whole, so the result is the same.
- **Replay on the restart in 9**: the restart shares stdin with the first start, so a request the first start already read is not sent again.

## Safety

No change. The agent starts the same servers with the same env, read-only unless the Connection's Access Level says write. The install runs `npm install` of the package the server already ran through `npx`, into the data folder.

## Seams

- **`NpmPackages.prepare`**: a fake npm and a temporary data folder. Covers 2 to 8.
- **`runMcpExec`**: a fake npm and a bin that records its arguments and env. Covers 1, 8, 9, 10.
- **`McpConnectionTester.run`**: the same fake with a counting MCP server. Covers 1 and 9.
- **Real npm**: one test installs `which` and runs its bin; it skips when the registry is unreachable.
