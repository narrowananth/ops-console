# Settings: Repos

**Status:** shipped
**Design:** Settings › Repos: Import a local repo, Imported repos list, Remove with confirm

## Problem

Sessions, Verifications and Fixes run inside a local git repository, and Monitor links each Service to one. The operator needs to tell the console which folders on this machine are Repos, and see each one's branch and host, before any of that can start.

## Behavior

1. Importing a path stores a Repo. A leading `~` is expanded, and a path inside a repository resolves to its top folder. The name is the folder name. The response says the branch it is on: "Imported `<name>` · branch `<branch>`".
2. A path that does not exist or is not inside a git repository is refused with `not_a_repo`. An empty path is `validation_failed`.
3. A top folder already imported is refused with `duplicate`.
4. The host comes from the `origin` remote URL: `github`, `gitlab` or `bitbucket`, with `remote_slug` set to `owner/name`. A Repo with no `origin`, or one on another host, is `local`. The default branch comes from `origin/HEAD`, else the current branch.
5. Listing Repos returns them by name with the current branch and dirty state read from git each time. A Repo whose folder is gone shows `missing: true` and no branch.
6. Renaming a Repo changes only its display name.
7. Removing a Repo deletes its row and leaves the folder untouched. Once `07-workspace` adds Sessions, removing a Repo that has Sessions is refused with `repo_has_sessions`.
8. Listing a Repo's branches reads git each time: local branches by most recent commit, the current one marked. A missing folder returns `not_found`.
9. A Repo's `.mcp.json` servers appear in Settings › MCP servers with scope `project` and this Repo (`03-settings-mcp-servers`). A server Claude Code has not approved yet reads `auth` with "pending approval in Claude Code".
10. Adding a MCP server with scope `project` takes a `repo_id` and writes the Repo's `.mcp.json` once, with one `claude mcp add`; removing it removes it from that file. A project server cannot move to another scope.

## Settled

- **Identity**: a Repo is its top folder. Two Repos may share a name; the path tells them apart.
- **Live, not stored**: branch, dirty state and the branch list.
- **Groups**: not in this spec. Repos are one flat list.
- **Project servers**: a name a user or local server already holds wins over the same name in a `.mcp.json`. A removed project server keeps no Repo, so Authenticate on its row is refused with `validation_failed`; it is added again from the form.

## Not required

- **Branch names refreshed in place**: the list shows the branch as of the last read; reading it again updates it.
- **Discovering repos**: the console does not scan the machine for repositories. The operator imports each one.

## Safety

No change. Importing reads git metadata only. The agent cannot import or remove a Repo.

## Database

```sql
CREATE TABLE repos (
  id              TEXT PRIMARY KEY NOT NULL,
  name            TEXT NOT NULL,
  path            TEXT NOT NULL UNIQUE,          -- top folder of the repository on this machine
  host            TEXT NOT NULL,                 -- GitHost
  remote_slug     TEXT,                          -- 'owner/name' on the host; null for local
  default_branch  TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
```

Enums live in code only (`01-base-daemon-setup`):

| Enum | Values | Used by |
| ---- | ------ | ------- |
| `GitHost` | `github`, `bitbucket`, `gitlab`, `local` | `repos.host` |

Migration of existing rows: none; the table is new.

## API

### Common

Envelopes, auth and shared error codes come from `01-base-daemon-setup`. This spec adds one code. `07-workspace` adds `repo_has_sessions` for removing a Repo that still has Sessions.

| Status | Error code | When |
| ------ | ---------- | ---- |
| 400 | `not_a_repo` | The path does not exist or is not inside a git repository |

`Repo`: all `repos` columns, plus `branch`, `dirty` and `missing`, read from git.

| Method and path | Body | Returns |
| --------------- | ---- | ------- |
| `GET /repos` | | `Repo[]` by name |
| `POST /repos` | `{ path }` | 201 `Repo`; `not_a_repo`, `duplicate`, `validation_failed` |
| `PATCH /repos/:id` | `{ name }` | `Repo` |
| `DELETE /repos/:id` | | 204; `repo_has_sessions` |
| `GET /repos/:id/branches` | | `{ name, current }[]`; `not_found` when the folder is gone |

## UI

Settings › Repos, as designed: the path field with Import (Enter also imports) and the result message below it, then "Imported repos" with a count, one row per Repo (name, path, branch, host), and Remove with an inline "Remove from the list?" confirm.

- Empty: "No repos yet. Import one above."
- Error: the refusal message under the field ("`<name>` is already imported", "Not a git repository").
- Missing folder: the row says the folder is gone, with Remove.

## Rejected

- **The design's duplicate check by name**: two folders can share a name. The path is the identity.
- **Storing branch and dirty state**: they change with every checkout and edit in the operator's own terminal.

## Glossary

- **Repo** (changed): A local git repository imported into the console, identified by its top folder, where Sessions run.

## Seams

- **Backend + SQLite, over HTTP** (real git in temporary folders): 1 to 8. Builds repositories with and without remotes, imports them, moves and deletes folders, and reads the responses.
- **Backend + SQLite, over HTTP, with `03-settings-mcp-servers`**: 9, 10. A Repo with a `.mcp.json` shows its server in the MCP list.

## Out of scope

- Repo groups: a later spec.
- Linking a Service to a Repo: `08-monitor-dashboard`.
- Open pull requests per branch, checkout and stash: `07-workspace`.
