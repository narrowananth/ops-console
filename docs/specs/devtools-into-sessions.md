# Dev tools into Sessions, with Connections picked from the Repo

**Status:** shipped
**Design:** the sidebar (`design/ops-console-sidebar.html`) loses its Dev tools item; the composer's Connections menu of [session-connections](session-connections.md) is the one place a Session gets databases.

## Problem

Since [session-connections](session-connections.md) a Session reaches databases through the composer's Connections icon, and a
Session is where the operator checks data and carries on to the fix. The Dev tools page is a second place for the same
questions, with its own terminal and scope picker, so there are two screens to learn and the answers do not sit beside the code.

The operator also has to tick Connections by hand, even when the Repo already says which database it uses: its `.env`
names the host.

## Behavior

### Dev tools page

1. The sidebar has no Dev tools item and `/devtools` opens the Sessions page. A saved address or a link to it does the same.
2. An existing `devtools` Session stays. It opens in the Sessions page as any Session does, shows its Connections as chips,
   takes messages, and keeps its scope exactly: an empty scope still reaches every Connection with access.
3. No new `devtools` Session can be made: `POST /sessions` with that kind answers `validation_failed`.
4. The Agent runs page links a `devtools` run to its Session in the Sessions page, not to Dev tools.
5. Result tables and a Comparison in a Session's transcript are drawn as they were in Dev tools: a `ops-result` block as a
   table, an `ops-compare` block as a Comparison.
6. A Session with ticked Connections tells the agent the Dev tools answer format: one `ops-result` block per Connection, an
   `ops-compare` block when two or more describe the same thing, and the closing line with the row and Connection counts.

### Connections picked from the Repo

7. When a `repo` Session is created, the console reads the `.env` files in the Repo's own checkout (the imported Repo's
   folder, not the Session's worktree) and ticks each Connection that file names, as in 9 and 10. The ticks are ordinary
   scope rows: the operator sees them as chips and in the menu, and a tick or an untick later is kept.
8. A Session with no Repo (anonymous) is not matched. A Repo added to it by a clone is not read either.
9. A Connection is named by an `.env` through its `host` field, or the hostname of a URL in a string field of its config (a
   value holding `://`), and no other string: a user or database name with a dot in it names nothing. The host matches as a
   token, in any case: the character before it is not a letter, digit, `.`, `_` or `-`, and the character after is not a
   letter, digit or `-`, nor a `.` that goes on with a letter or digit. So `db.example.com` is found in
   `HOST=db.example.com:5432`, `postgres://u:p@db.example.com/app`, quotes and at a line's end, and not in
   `notdb.example.com.evil` or `db.example.com.evil`; `10.0.0.5` is not found in `10.0.0.55`. A host of fewer than 5
   characters, or with no dot, never matches. For a Connection on this machine (`localhost`, `127.0.0.1`, `::1`,
   `0.0.0.0`) it is named only when its port appears as a number token and its database name appears as a token, by the
   same rule; one with no port or no database name is never named.
10. Only a Connection with Access Level `read` is ticked. One with `write` or `none` never is, so no automatic tick lets the
    agent write. A PROD Connection with Access Level `read` is ticked for a `repo` Session when it is made, and shows its
    PROD tag; the operator sees it ticked and can untick it.
11. A PR Session (the Session of a pull request's Review, Check reply, Address comments and thread replies) reaches the
    non-PROD Connections with Access Level `read` its Repo's `.env` names, found at each run from the Repo's own checkout
    and never from the pull request's branch or text. It never gets a PROD Connection this way: it reads pull request text
    and comments the operator did not write, and the result of a query a comment steered could go back out in a posted
    comment. They are not stored and not shown in the menu, since a PR Session has no composer. The chips in the Session
    panel show them. A list of Sessions reuses the match for 5 seconds, per folder and set of Connections, so it reads each
    folder once; a run always reads again.
    Which files count: a name ending `.example`, `.sample`, `.template` or `.dist` does not, and neither does a file git
    tracks in the Repo's folder (`git ls-files --error-unmatch`; a failure, a folder that is not a repository or a 2
    second wait counts as not tracked). A tracked file is repository content a pull request can change, not the operator's
    own local config. A link, a pipe, a device, a directory or a file over 1 MB is skipped alone and never stops the
    other files.
12. A job the console starts keeps its own reach (Verify's read-only Connections, Fix none), as in
    [session-connections](session-connections.md) 10.
13. A Connection added, renamed or changed after a Session was created does not change that Session's ticks. The operator
    ticks it, or makes a new Session.
14. Reading the `.env` never leaves the daemon: the Connection names that matched go in the scope and the prompt, and the
    file's text, values and secrets go nowhere, not into the prompt, the transcript, a log or an Action Log row.
15. A missing or unreadable `.env`, a link, a pipe, a device, a directory or a file over 1 MB, or a Repo with no matches
    ticks nothing and raises no error.
16. An Action Log row of kind `query` before every query, a step naming the Connection and its Access Level, and an
    Approval for a PROD write in every Access mode all hold as in Dev tools (`09-dev-tools-agent`).

### What must not regress

17. The composer's Connections menu, the Connections page, the Connection's Access Levels, the Result and Comparison
    drawing in a Session, and every other page behave as before.

## Settled

- **When**: once at creation for a `repo` Session, so the operator's later ticks stand; at every run for a PR Session, which
  has no composer to correct it.
- **Where the file is read**: the Repo's own checkout, never the Session's worktree or a PR's branch. A pull request can
  edit `.env`, and what it names must not widen the agent's reach.
- **Read only**: the automatic tick is limited to Access Level `read`.
- **Host matching** for the automatic pick is stricter than the PROD tag on a process, which is unchanged: any `.env`
  file counts there and a host matches as text. The pick uses tokens, 5 characters or more, only the `host` field and
  URL hostnames, and only the operator's untracked local files.
- **`devtools` Sessions stay** as a kind that can no longer be made, so no history is lost and no migration runs.
- **PR Sessions change**: [session-connections](session-connections.md) gave a pull request's Session no Connection scope. This spec
  gives it the non-PROD Connections its Repo's `.env` names, read only, found at each run from the Repo's own checkout, so a
  pull request cannot choose them. Nothing else about that Session's reach changes.
- **Cost of a list**: the views of a Sessions list reuse a match for 5 seconds, not a lazy match for the open Session, since
  the Sessions list has no notion of an open Session.
- **Removed screens**: the Dev tools page and its scope picker. Their Result and Comparison drawing stays, since the
  transcript uses it.

## Not required

- **Matching the Repo's other config**: `application.yml`, `docker-compose`, secrets managers. Only `.env` files.
- **A Connection the `.env` does not name.** The operator ticks it.
- **Matching for an anonymous Session**, or after it clones a Repo.
- **Re-matching** an existing Session when a Connection or a `.env` changes.
- **A Dev tools terminal** (tabs, per-terminal scope, typed-text drafts).
- **A "from .env" note** on a chip that the Repo's file ticked.
- **Guarding the Repo's `.env` from a Session that opened another Repo.** A Session that opened another Repo can write that
  Repo's untracked `.env`, which widens that Repo's PR Sessions on their next run.
- **Undoing a tick when Access Level rises.** A Connection raised to `write` after it was ticked stays ticked, and write
  follows its Access Level.
- **Mongo and Redis Connections.** They have no host or database in their config and are never named.

## Safety

This widens what a Session reaches without the operator's click, so ADR 0002 changes: a Connection named by the Repo's own
`.env` is ticked for the Session. It is limited as follows. Only Access Level `read`, so no write; only the Repo's own
checkout, so a pull request's files, log text and the agent cannot choose the match; only files git does not track, so
repository content does not choose it; only Connections the operator already saved; a PR Session gets no PROD Connection,
and a `repo` Session's PROD tick is shown and can be unticked; PROD stays read-only and tagged, and a PROD write still asks in
every Access mode. The `.env` text is read by the daemon for names and never shown to the agent. A Connection named by a
`.env` the operator did not mean to connect (a shared host) is reachable read-only until they untick it; this is the cost.
A pull request's text can still steer a read query on a non-PROD Connection, and its result can go back in a reply.

## Database

None. Ticks are `session_connections` rows, as in [session-connections](session-connections.md). No migration: existing
Sessions keep their rows.

## API

### `POST /sessions`

A body with `kind: "devtools"` answers `validation_failed`. A `repo` Session's response carries the ticked ids in
`connection_ids`, as it does for any scope.

No new route. `connection_ids` for a PR Session holds the ids of the non-PROD Connections its Repo's `.env` names, read
from the Repo's folder when the Session is read (reused for 5 seconds) and stored nowhere, so the Session panel shows them. `PATCH` of `connection_ids` on it still answers
`validation_failed`.

## UI

- **Sidebar**: no Dev tools item. The Operate group is Sessions, Pull requests, Monitor.
- **Session panel**: the Connections chips show the ticked ones, and a PR Session's matched ones. A PR Session's
  composer has no Connections menu.
- **Agent runs**: the link for a `devtools` run opens its Session.
- Empty states and PROD tags as in [session-connections](session-connections.md).

## Rejected

- **Agent asks, the operator approves in one click**: the safer option, offered and not chosen. The operator chose an
  automatic tick from the Repo's `.env`.
- **Tick every read-only Connection when the task mentions data**: the agent or pull request text would pick what it
  reaches.
- **Delete the `devtools` kind and its Sessions**: a migration for history the operator may still want.

## Glossary

- **Connection scope** (changed): also lists the Connections the Repo's `.env` names for a `repo` Session at creation, and
  for a PR Session at each run, non-PROD only.

## ADR

- **Operator approves agent never merges** (0002): rewrite in place. A Session also reaches a read-only Connection the
  Repo's own `.env` names, ticked by the console and not by the operator. Considered Options gains "the agent asks and
  the operator approves" and "every read-only Connection", with why each lost, and the PR Session limits (non-PROD, read
  only, from the operator's untracked local config) and the trade-off above.

## Seams

- **Matching** (unit): 9, 10, 11 (files that count), 14, 15.
- **Session creation and PR runs** (backend + SQLite, fake agent runtime): 7, 8, 11 (no PROD, reuse for a list), 12, 13, 16.
- **Dev tools removal** (backend + SQLite over HTTP): 2, 3.
- **Sidebar, redirect, panel chips, Agent runs link** (frontend e2e): 1, 4, 5, 6, UI.
- **Regression**: 17 by the existing tests.

## Out of scope

- Matching from other config files, re-matching, a Dev tools terminal, and deleting the `devtools` kind.
