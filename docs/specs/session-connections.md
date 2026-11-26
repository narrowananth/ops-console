# Connections in any Session

**Status:** shipped
**Design:** the composer's Repos icon in the Session screen (`design/ops-console.html`) for the picker; the Dev tools scope picker (`09-dev-tools-agent`) for the rows. Departure: a Connections icon beside the Repos icon.

## Problem

The operator wants to ask a database a question inside the Session they are already working in: "where is shop acme's
config stored, and what does it hold?", check the answer, then carry on in the same conversation and fix the code. Only a
Dev tools Session reaches Connections. So the operator asks in Dev tools, checks the answer there, opens a Session, and
pastes the findings into a new prompt.

## Behavior

1. A `repo` or `anonymous` Session has a Connection scope. A new Session's scope is empty, and an empty scope reaches no
   Connection: no database server starts, so a Session that never asks for one pays no start-up cost.
2. The composer has a Connections icon beside the Repos icon. It opens a menu of the Connections A to Z, each with a
   check box, its brand icon and name. A PROD Connection carries the PROD tag. A Connection with Access Level `none` is
   disabled, with a hint to set its Access Level in Connections. With none ticked the icon is plain; with some ticked it
   shows their count.
3. Ticking or unticking applies to the Session's next run and survives a reload, a second tab and the daemon's restart.
   Every open page shows the change (`session.updated`).
4. A run the operator starts in that Session gets the MCP servers of the ticked Connections, launched as each one's
   Access Level says (`05-settings-dev-tools`). A Connection that is not ticked is not reachable in that run.
5. The agent is told which Connections it has and that it only reads unless the operator asks for a change. Rows it
   fetches come back as the Dev tools Result table (`ops-result`), and it may save the data as an Output file
   ([output-viewer](output-viewer.md)).
6. Each query follows the Dev tools rules unchanged (`09-dev-tools-agent` 5 to 8): an Action Log row of kind `query`
   before it runs, a `step` part naming the Connection and its Access Level, an Approval for a write on a PROD Connection
   with Access Level `write` in every Access mode, and a Connection that is down or needs a login reported and skipped.
7. A Connection set to Access Level `none` leaves every Session's scope. Deleting a Connection removes it from every
   scope. The Session stays.
8. A Connection that does not exist is refused with `not_found`. One with Access Level `none` is refused with
   `connection_no_access`. A refused change leaves the scope as it was.
9. A Fork of a Session carries its scope. A Spawned Session starts with an empty one.
10. A job the console starts (Verify, Fix, a pull request review or reply, Open pull request) ignores the Session's scope
    and keeps its own rules (`agent-playbooks`). The operator's messages in an Alert's Session use the scope. A PR Session has no
    scope: its runs reach the non-PROD read Connections its Repo's `.env` names ([devtools-into-sessions](devtools-into-sessions.md)).
11. A Dev tools Session behaves as before, including that an empty scope there means every Connection with access.
12. Two Sessions with different scopes run side by side, each reaching only its own.

## Settled

- **Empty means none here**: the opposite of Dev tools, where empty means every Connection. A coding Session reaching a
  database by leaving something blank would surprise the operator.
- **Same storage**: the Session's scope sits in the table Dev tools already uses, `session_connections`.
- **Same rules**: Access Levels, the PROD-write Approval, the Action Log and the read-only launch are Dev tools' own
  (`09-dev-tools-agent`), not copied.
- **Only the operator's messages**: a console-started job's reach is chosen by its purpose, not by the Session.
- **PR Session**: no scope of its own. It reaches the non-PROD read Connections its Repo's own `.env` names, found at each run
  ([devtools-into-sessions](devtools-into-sessions.md)); it refuses `PATCH` of `connection_ids`.

## Not required

- **A Connections default for new Sessions.** Each Session starts with none ticked.
- **A scope the operator edits on a PR Session** (no composer), and on a Spawned Session. A PR Session's reach comes from its Repo's `.env` ([devtools-into-sessions](devtools-into-sessions.md)).

## Safety

The operator's runs in a `repo` or `anonymous` Session may now reach ticked Connections. They reach none unless ticked, and
a ticked one follows its Access Level: `read` launches the server read-only, and a PROD write asks in every Access mode,
`full` included. Log text, PR text and a file the agent reads cannot tick a Connection: only the operator's click or
`PATCH` does, and the agent has no tool that changes the scope. Jobs keep their own scope, so log text that steers a
Verification still reaches no Connection beyond today's read-only ones (ADR 0002). No new host, command or credential.

## Database

None. `session_connections` already holds `(session_id, connection_id)` for any Session.

Migration of existing rows: none; every existing `repo` and `anonymous` Session has no rows, so an empty scope.

## API

### `POST /sessions` (extends `09-dev-tools-agent`)

`connection_ids: ["uuid"]` is also accepted for `repo` and `anonymous` Sessions. Errors: `connection_no_access`, `not_found`.

### `PATCH /sessions/:id` (extends `09-dev-tools-agent`)

`connection_ids` is accepted for `devtools`, `repo` and `anonymous` Sessions; any other kind answers `validation_failed`.
Applies to the next run and sends `session.updated`.

### `Session`

`connection_ids` is the scope for those three kinds, `null` for the others.

## UI

- **Connections menu** in the composer, as in Behavior 2. Empty state: "No Connections yet." with an "Add one in
  Connections" link. The menu follows the Repos menu's look.
- **Session header or panel**: the ticked Connections show as chips with PROD tagged, so the operator sees what the
  agent can reach before asking.
- **Approval** for a PROD write shows as in Dev tools, above the transcript.

## Rejected

- **Every Connection in every Session**: seconds of start-up and about 20k prompt tokens on every run, for the many
  Sessions that never touch a database.
- **The agent ticks Connections itself**: log or file text could widen its own reach.
- **Dev tools page only**: the operator copies findings between two screens.

## Glossary

- **Connection scope**: the Connections a Session's runs may reach. Empty reaches none in a `repo` or `anonymous`
  Session and every Connection with access in a Dev tools one.

## Seams

- **Scope API** (backend + SQLite, over HTTP): 1, 3, 7, 8, 9, 11.
- **Run options** (backend, fake agent runtime): 4, 5, 10, 12.
- **Query rules in a repo Session** (backend + SQLite, over WebSocket): 6.
- **Composer menu** (browser): 2, 3.

## Out of scope

- A default scope, scope for jobs.
