# Repo follows the Git host's owner

**Status:** shipped
**Design:** none. One line on the Repos page.

## Problem

A Repo's Git host and `owner/name` were stored once, at import. When an organization on the Git host is renamed, the
console keeps the old owner: the pull request list shows the new owner's pull requests as "not imported", and the old
owner's read fails. The operator would have to change every folder's `origin` and import again.

## Behavior

1. `git@ssh.bitbucket.org:owner/name.git` and the `altssh.bitbucket.org` form are Bitbucket remotes, as `bitbucket.org`.
2. When a Repo's `origin` changes to a known host, the stored host and `owner/name` change with it. This is read at
   start and each time the Repos list is read. A folder that is gone, or an `origin` that names no known host,
   changes nothing.
3. A pull request list that holds a repository under an owner no imported Repo has, while exactly one imported Repo
   on that host has the same repository name and no match in the list, stores the host's `owner/name` on that Repo.
   Two imported Repos with that name, or two unmatched repositories with that name, map nothing.
4. The folder's `origin` is not edited. The Repo remembers what `origin` last said, so the next read of the Repos does
   not undo the host's `owner/name`; a later change of `origin` is followed.
5. While `origin` and the stored `owner/name` differ, the Repo's row on the Repos page says what the host calls it and
   what the folder's `origin` still says.

## Not required

- Rewriting `origin`: the operator repoints git when they want to. Rejected: it changes a repository's config unasked.
- Mapping by commit: needs the branch fetched, so quiet Repos stay unmapped.
- A Repo with no pull request in the moved repository stays on its old owner until `origin` changes or a pull request appears.

## Database

`repos.origin_slug text`: the `owner/name` `origin` named when last read; null until the first read.

## API

`Repo` gains `origin_slug`: `owner/name` when it differs from `remote_slug`, else `null`.

## Seams

- **Daemon + SQLite** (`backend/test/workspace.test.ts`, `backend/test/repos.test.ts`): 1 to 4.
- **Browser** (`frontend/e2e/repos.spec.ts`): 5.
