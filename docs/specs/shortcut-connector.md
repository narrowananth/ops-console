# Shortcut Connector

**Status:** shipped
**Open:** the hosted server's tool names are unpublished, so the word rule is checked against the archived server's names only, and no real sign-in, read or write ran.
**Design:** the Connector pane of Integrations (`design/ops-console.html`), as for Notion and Sentry: a numbered sign-in step and Disconnect. The Approval card is the existing one.

## Problem

The operator tracks stories, epics and iterations in Shortcut and wants a Session to read them, and to write back when the
operator agrees: a story created from a review, a comment on an epic, a story moved. Today the operator pastes text into
the Session. Shortcut offers a hosted MCP server, but the console has no Connector for it, so it has no one-click
sign-in and no status.

## Behavior

### Connector

1. Integrations lists Shortcut as a nineteenth Connector, after Notion, with status `off`.
2. Connect takes no body. It registers the `shortcut` MCP Server at `https://mcp.shortcut.com/mcp` in every account if it
   is missing, turns it on if it was turned off, and starts the browser sign-in through Claude Code in the active account.
   The operator types nothing in the console. The status follows the server's, as for Notion.
3. A sign-in the operator does not finish within 5 minutes is stopped and reads `auth`. Cancel stops one that waits.
   Disconnect removes the server and clears the stored state, and signs the operator out of nothing at Shortcut. A Shortcut
   server turned off in Integrations reads `fail`, "shortcut is turned off in MCP servers", and Connect turns it back on.
4. A Session's own runs (the operator's messages) can call Shortcut's tools. A job the console starts, and a pull request's
   Session, do not reach Shortcut.
5. The agent is told, when Shortcut is connected and the run can use it, which kinds of tool read, which change things and
   ask the operator, and which delete or archive and always ask.

### Tool classes

6. Shortcut's server does not publish its tool names, so its classes are a rule on the words of the name, split at `-` and
   `_`, not a list. A name with a word of the **delete** group (`delete`, `remove`, `archive`, `destroy`) is destructive. Else a name with a
   word of the **write** group (`create`, `update`, `add`, `set`, `assign`, `unassign`, `upload`, `move`, `merge`, `link`,
   `unlink`, `start`, `stop`, `run`, `cancel`, `apply`, `approve`, `publish`) is a write. Else a name with a word of the
   **read** group (`get`, `search`, `list`, `find`, `read`, `whoami`, `current`) is a read. Any other name is destructive.
   The first matching group wins in that order, so `stories-remove-subtask` and `stories-get-and-delete` are destructive.
7. Reads run. Writes raise an Approval in every Access mode but `full`, where they run at once. Destructive tools, and any
   name no group matches, raise an Approval in every Access mode, `full` included. This is the behavior of
   [notion-connector](notion-connector.md) 6 to 10, with the class found by the rule in 6.
8. A name the console cannot place asks every time. The operator sees it on the Approval card, which names the tool.
9. An Approval for a Shortcut tool names the service, the tool and its main inputs (the story, epic or iteration it acts on,
   the title or text, capped in length), with Approve and Deny as for any command. Each call that is not a read writes an Action Log row before it runs.
10. Shortcut may refuse a call: an item the account cannot reach, a rate limit (200 requests a minute on the REST API).
    The agent receives Shortcut's message and the Connector's status does not change.
11. Figma and Notion keep their own rules. What must not regress: the other eighteen Connectors, the MCP servers page,
    Sessions while Shortcut is not connected (no server starts and the agent is told nothing about Shortcut), and the
    Approvals of PROD writes and commands.

## Settled

- **Hosted server, no bridge.** Shortcut's own repository of a local MCP server is archived. The hosted server signs in with
  OAuth, so the console holds no token, and no API token is asked for.
- **A rule on words, not a list**, because the hosted tool names are unpublished. The archived local server's names
  (`stories-get-by-id`, `stories-search`, `stories-create`, `stories-update`, `stories-create-comment`, `epics-delete`) are
  the shape the rule is built for, and the tests use them. Whether the hosted names follow that shape is not known until the
  first sign-in.
- **Remove counts as delete.** Removing a subtask or a link is reversible, but the rule does not tell it from removing a
  story, so it asks every time.
- **Update asks, not always.** An update can archive a story, which a word rule cannot see. The Approval shows the call's
  inputs so the operator can.
- **Server names**: the rule applies to the console's `shortcut` server and to Shortcut's server under the names a plugin
  or a claude.ai connector gives it, in any case.

## Not required

- **A Shortcut token and the REST API.** No bridge is built.
- **A list of Shortcut's tools** in the pane, until the operator's first connection shows the real names.
- **Telling a reversible remove from a delete.**
- **Enforcing Shortcut's rate limit.** The console shows what Shortcut answers.

## Safety

As for [notion-connector](notion-connector.md): reads run; a write needs the operator's yes except in `full` access; a delete
and any tool the rule cannot place needs a yes in every mode. Shortcut's text (a story, a comment) cannot start a delete in
any mode, nor a write in any mode but `full`. Jobs and pull request Sessions reach no Shortcut server. The sign-in lives in
Claude Code's store and the console keeps no credential.

## Database

```sql
INSERT INTO connectors (id, status, config) VALUES ('shortcut', 'off', '{}') ON CONFLICT DO NOTHING;
```

One migration, as `0055_connector_notion`. Migration of existing rows: none.

## API

### `GET /connectors`

Returns nineteen Connectors in the fixed order, Shortcut after Notion. Its `via` reads "Shortcut MCP". Its config is an
empty object, and a `PATCH` with any field answers `validation_failed`.

### `POST /connectors/shortcut/connect`, `DELETE /connectors/shortcut/sign-in`, `DELETE /connectors/shortcut/credentials`

Connect, Cancel and Disconnect, as for every Connector.

## UI

- **Connector pane**: Shortcut's brand icon, one numbered step "Sign in to Shortcut" with Connect, then status and
  Disconnect. A note under the step: "Sessions can read your stories, epics and iterations. A change asks you first, a
  delete always asks, and Full access skips the first. A tool the console cannot place asks every time. Shortcut's own
  limit is 200 requests a minute."
- **States**: off, waiting for sign-in (with Cancel), connected, `auth` with the reason, `fail` when the server is off.

## Rejected

- **A console bridge on the REST API with an API token.** Needed while Shortcut had only a local server. The hosted server
  signs in with OAuth and needs no credential from the console.
- **The archived local server** (`npx @shortcut/mcp`): archived, takes a full-access token.
- **Refuse every tool the console cannot place.** The operator could not use a new tool. Asking is safe and usable.

## Glossary

- **Tool class** (changed): the classes of a server are a list of tool names, or for a server that publishes none, a rule on
  the words of the name.

## ADR

- **Operator approves agent never merges** (0002): no change beyond [notion-connector](notion-connector.md), which already
  says the agent changes a service outside this Mac only by asking. Shortcut joins the list.

## Seams

- **Word rule** (unit): 6, 7, 8.
- **Run guard and Approval** (backend + SQLite, fake agent runtime): 4, 5, 7, 9.
- **Connector list and Connect** (backend + SQLite, over HTTP, fake MCP server): 1, 2, 3, 11.
- **Pane** (frontend e2e, API mocked): 1, UI states.
- **Sign-in, a real read and a real write** (the operator's Shortcut account, by hand): 2, 6, 9, 10.

## Out of scope

- A REST API bridge, a tool list in the pane, enforcing Shortcut's limit.
