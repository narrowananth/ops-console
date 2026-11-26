# Notion Connector, and tool classes

**Status:** shipped
**Open:** the sign-in and a real read and write against Notion are not run: Behaviors 2, 7, 8 and 11 are checked against a fake server and a fake agent runtime only.
**Design:** the Connector pane of Integrations (`design/ops-console.html`), as for Sentry and Figma: a numbered sign-in step and Disconnect. The Approval card is the existing one.

## Problem

The operator keeps specs, notes and meeting records in Notion and wants a Session to read them, and to write back when the
operator agrees: a page created from a design, a comment on a spec, a database row updated. Today the operator pastes text
into the Session. Notion has an MCP server, but the console has no Connector for it, so it has no one-click sign-in and no
status, and the console has no way to let a server's reads run while its writes ask first and its deletes always ask.

## Behavior

### Connector

1. Integrations lists Notion as an eighteenth Connector, after Figma, with status `off`.
2. Connect takes no body. It registers the `notion` MCP Server at `https://mcp.notion.com/mcp` in every account if it is
   missing, turns it on if it was turned off, and starts the browser sign-in through Claude Code in the active account. The
   operator types nothing in the console. The status follows the server's, as for Sentry.
3. A sign-in the operator does not finish within 5 minutes is stopped and reads `auth`. Cancel stops one that waits.
   Disconnect removes the server and clears the stored state, and signs the operator out of nothing at Notion. A Notion
   server turned off in Integrations reads `fail`, "notion is turned off in MCP servers", and Connect turns it back on.
4. A Session's own runs (the operator's messages) can call Notion's tools. A job the console starts, and a pull request's
   Session, do not reach Notion.
5. The agent is told, when Notion is connected and the run can use it, which Notion tools read, which change things and
   ask the operator, and which delete and always ask.

### Tool classes

6. Each tool of a server with classes is in one of three classes, listed per server in the console. **Read** tools raise no Approval of their own: they run, and the Access mode's usual question about MCP tools still applies
   (supervised and accept edits ask about every MCP tool, as they do for any server today).
   **Write** tools raise an Approval in every Access mode but `full`, where they run at once. **Destructive** tools raise
   an Approval in every Access mode, `full` included. A tool the list does not name counts as destructive, so a tool the
   vendor adds later asks until the list names it.
7. Notion's classes:
   - Read: `notion-search`, `notion-fetch`, `notion-connector-search`, `notion-list-private-pages`,
     `notion-list-shared-pages`, `notion-list-favorite-pages`, `notion-list-recent-pages`, `notion-list-page-backlinks`,
     `notion-query-meeting-notes`, `notion-query-data-sources`, `notion-query-multiple-data-sources`, `notion-get-comments`,
     `notion-get-version-changes`, `notion-view-version`, `notion-get-suggested-edit`, `notion-get-async-task`,
     `notion-get-self`, `notion-get-teams`, `notion-get-groups`, `notion-get-users`, `notion-get-tool-access`.
   - Write: `notion-create-pages`, `notion-update-page`, `notion-move-pages`, `notion-duplicate-page`,
     `notion-create-database`, `notion-update-data-source`, `notion-create-view`, `notion-update-view`,
     `notion-create-comment`, `notion-update-comment`, `notion-set-discussion-resolved`, `notion-set-comment-reaction`,
     `notion-create-suggested-edit`, `notion-resolve-suggested-edit`, `notion-restore-version`, `notion-restore-pages`.
   - Destructive: `notion-delete-pages`, `notion-delete-databases`, `notion-delete-comment`, and any tool not listed.
8. An Approval for a Notion tool names the service, the tool and its main inputs (the page or database it acts on, the
   title or text, capped in length), with Approve and Deny as for any command. Approve runs the call. Deny tells the agent
   the operator denied it and not to retry another way.
9. Each Notion call that is not a read writes an Action Log row before it runs, with the tool and its target, and no
   page content beyond the capped summary.
10. The Approval waits like any other: the run shows Waiting for approval, the Agent runs page counts it under needs you, a
    reload keeps it, and Stop expires it.
11. Notion may refuse a call: a page the account cannot reach, a rate limit (180 requests a minute on other plans, 600 on
    Business and Enterprise). The agent receives Notion's message and the Connector's status does not change.
12. Figma keeps its own rule: read only, every other tool refused with no Approval, as in
    [figma-connector](figma-connector.md). Classes do not change it.
13. What must not regress: the other seventeen Connectors, the MCP servers page, Sessions while Notion is not connected (no
    server starts and the agent is told nothing about Notion), and the Approvals of PROD writes and commands.

## Settled

- **Write asks, destructive always asks**: the console's own tools run at once in `full` access, and a PROD write still
  asks there. Deleting from a service outside this Mac is the other thing `full` does not skip.
- **Unlisted means destructive**: it asks. It is not refused, so a new Notion tool works the day it ships, with an
  Approval each time, until the list names it.
- **Server names**: the list applies to the console's `notion` server and to Notion's server under the names a plugin or a
  claude.ai connector gives it, in any case, as for Figma.
- **Which Approval kind**: a Notion Approval is a `command` Approval. It shows no PROD tag.
- **Deleted content**: Notion's own delete moves a page to Trash, which Notion keeps. The console treats it as destructive
  regardless.
- **Writes through a job**: none. Jobs reach no Notion server, so no write can start from log or pull request text.
- **Sign-in**: OAuth with PKCE and dynamic client registration, through Claude Code, so the console holds no credential. A
  Notion MCP token (Business and Enterprise) is not used.

## Not required

- **Notion's files, skills, agents and calendar tools.** The documentation read did not cover them. They count as
  destructive until read and listed.
- **A Notion API bridge** or the older `/sse` address, which Notion retires on 2027-02-23.
- **Read-only Notion.** Notion has no read-only mode. An operator who wants one denies the Approvals.
- **Enforcing Notion's limits.** The console shows what Notion answers.

## Safety

The agent gains Notion's tools in the operator's own chat runs. Reads run. A write needs the operator's yes, except in
`full` access, where the operator has chosen not to be asked about the console's own writes; a delete, and any tool not
listed, needs a yes in every mode. Text from a Notion page, a comment or a pull request cannot start a write by itself in
any mode but `full`, and cannot start a delete in any mode. In `full` access a page's text can steer a write: that is the
mode's meaning, and the pane's note says that Full access skips the question for a change. Jobs and pull request Sessions reach no Notion
server. The sign-in lives in Claude Code's store. No new credential is kept by the console, and no PROD Connection is
touched.

## Database

```sql
INSERT INTO connectors (id, status, config) VALUES ('notion', 'off', '{}') ON CONFLICT DO NOTHING;
```

One migration, as `0054_connector_figma`. Migration of existing rows: none.

## API

### `GET /connectors`

Returns eighteen Connectors in the fixed order, Notion after Figma. Its `via` reads "Notion MCP". Its config is an empty
object, and a `PATCH` with any field answers `validation_failed`.

### `POST /connectors/notion/connect`, `DELETE /connectors/notion/sign-in`, `DELETE /connectors/notion/credentials`

Connect, Cancel and Disconnect, as for every Connector.

### Approval for a Notion tool

A `command` Approval of the existing list and decision endpoints. Its summary reads `Notion: <tool>` and the capped inputs,
for example `Notion: notion-update-page, page 1f3a… "Release notes"`. No new field on the Approval.

## UI

- **Connector pane**: Notion's brand icon, one numbered step "Sign in to Notion" with Connect, then status and Disconnect. A
  note under the step: "Sessions can read your workspace. A change asks you first, a delete always asks, and Full access
  skips the first. Notion's own limits apply: 180 requests a minute, 600 on Business and Enterprise."
- **States**: off, waiting for sign-in (with Cancel), connected, `auth` with the reason, `fail` when the server is off.
- **Approval card**: as for a command, titled with the Notion tool.

## Rejected

- **Refuse every Notion write**: the operator wants to write back. Figma is read only by choice, Notion is not.
- **Ask for every Notion tool, reads too**: a Session reading a spec would stop at each search.
- **Treat unlisted tools as reads**: a new delete would run unasked.
- **Skip the delete Approval in `full` access**: deleting is the one thing the operator should still be asked about.

## Glossary

- **Tool class**: whether a tool of a server with classes reads, writes or deletes. A read runs, a write asks except in
  full access, a delete and any unlisted tool always ask.

## ADR

- **Operator approves agent never merges** (0002): rewrite in place. The agent also changes a service outside this Mac
  (Notion) only by asking: a write raises an Approval in every Access mode but `full`, and a delete in every mode. Merge
  stays the operator's button.

## Seams

- **Classes** (unit): 6, 7, 12.
- **Run guard and Approval** (backend + SQLite, fake agent runtime): 4, 5, 6, 8, 9, 10.
- **Connector list and Connect** (backend + SQLite, over HTTP, fake MCP server): 1, 2, 3, 13.
- **Pane** (frontend e2e, API mocked): 1, UI states.
- **Sign-in and a real read and write** (the operator's Notion account, by hand): 2, 7, 8, 11.

## Out of scope

- Notion files, skills, agents and calendar tools, a REST API bridge, and enforcing Notion's limits.
