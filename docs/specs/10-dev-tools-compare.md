# Dev tools: one question, every database, compared

**Status:** shipped
**Design:** Dev tools in `design/ops-console.html`: the "Synced dev tools" list beside the `ops-agent · dev tools` terminal

## Problem

The operator wants to ask one question ("find shop glowbar") and see what every database holds about it, without
opening a client per Connection or reading the agent's prose to work out which value came from where. Today the
Dev tools screen opens on an "Open terminal" button, the scope picker sits above a plain chat, and answers come back
as text. When Postgres says a shop is on `pro` and Mongo says `growth`, nothing shows the operator that the two
disagree.

## Behavior

1. The Dev tools screen opens ready to ask: the Synced dev tools list on the left and the terminal with its prompt on
   the right. With no `devtools` Session yet, the first question creates one with an empty scope and runs.
2. The list shows "All connected" with a count, then each Connection: type, name and a PROD tag. A Connection with
   Access Level `none` shows but cannot be picked. Picking Connections sets the Session's scope; picking "All
   connected" clears it. The change applies to the next run (`09-dev-tools-agent` Behavior 4).
3. The terminal header reads `ops-agent · dev tools · scope: <names>` or `scope: all connected (<n>)`.
4. A question that names no Connection or type runs on every Connection in scope. One that names a Connection or a
   type ("in mongo", "pg-tenant") narrows to those. The agent says which it picked in a `step` part before the first
   query.
5. Each Connection queried gives one Result: the Connection, the query, the columns, at most 50 rows, the row count
   and the time it took. It shows as a table under `── <name> · <type>`, tagged PROD where the Connection is.
6. A Connection in scope that is skipped (down, needs a login, read-only for a write) shows one line with the
   reason, as today (`09-dev-tools-agent` Behavior 8). A Connection with no matching rows shows `no matches`.
7. When Results from two or more Connections describe the same thing, the agent adds one Comparison: the key it
   matched on and its value, one column per Connection, one row per field. A row whose non-empty values differ is
   marked. With nothing shared, there is no Comparison and the summary says so.
8. The run ends with a summary line: `<rows> rows across <answered> of <queried> Connections`.
9. Results and Comparisons read back the same after a reload or from another tab, since they come from the
   transcript.
10. A Result or Comparison the console cannot read shows as a code block with its raw text. The rest of the
    message still shows.
11. Each Result and Comparison has Copy JSON.
12. A PROD write still waits for an Approval, which shows above the terminal with approve and deny (`09-dev-tools-agent` Behavior 7).
13. Two terminals still run side by side, each with its own scope (`09-dev-tools-agent` Behavior 10).

## Settled

- **How the agent hands over a table**: a fenced block in its reply, ```` ```ops-result ```` or
  ```` ```ops-compare ````, holding one JSON object. The console turns it into a `result` or `comparison` part,
  live and on read-back. Any other fence stays a `code` part.
- **Telling the agent**: a `devtools` run appends instructions to Claude Code's system prompt: fan out unless a
  Connection or type is named, one `ops-result` per Connection queried, one `ops-compare` when Results share a key,
  then the summary line.
- **Who marks a difference**: the console. A Comparison row is marked when two of its non-empty values differ as
  text. The agent's own opinion is not stored.
- **Caps**: 50 rows per Result and 200 characters per cell are shown; `total` keeps the real count. A larger
  block is cut on read, not refused.
- **PROD tag and type** on a Result come from the Connection with that name. A name the console does not know
  shows without them.
- **The Session starts on the first question**: the "Open terminal" button goes. "New terminal" (`+`) opens a blank
  terminal, and its Session starts on its first question too, so an unused terminal leaves nothing behind.

## Not required

- **Joins the console runs**: the agent matches the rows; the console only lays out what the agent sent
  (`09-dev-tools-agent` Not required, now with a Comparison to show the match).
- **Exact values**: the Result holds what the agent copied from the tool result. The `step` part above it still
  names the real query and Connection.
- **Paging past 50 rows**: the operator asks for the next page in words.

## Safety

No change. The agent reaches the same Connections with the same Access Levels; PROD writes still need an Approval;
every query still writes an Action Log row first.

## API

### `Part` (extends `02-settings-agents`)

Two kinds join the union. `session.output` and `GET /sessions/:id/messages` carry them unchanged.

```json
{
  "kind": "result",
  "connection": "pg-tenant",
  "query": "select id, shop_domain, plan from shops where shop_domain like '%glowbar%' limit 5",
  "columns": ["id", "shop_domain", "plan"],
  "rows": [["4812", "glowbar.example.com", "pro"]],
  "total": 1,
  "ms": 12
}
```

- `query`: the query as the agent ran it, or null.
- `rows`: cells are strings, numbers, booleans or null.
- `total`: rows the query matched, or null when unknown.
- `ms`: time the query took, or null.

```json
{
  "kind": "comparison",
  "key": "shop_domain",
  "value": "glowbar.example.com",
  "connections": ["pg-tenant", "mongo-prod"],
  "rows": [{ "field": "plan", "values": ["pro", "growth"], "differs": true }]
}
```

- `values`: one per entry in `connections`, null where that Connection has no value.
- `differs`: set by the console (Settled).

## UI

- **Dev tools screen** follows the design: the Synced dev tools list, then the dark terminal. Terminal tabs sit
  above the terminal in one row that scrolls sideways, oldest on the left. A tab shows the terminal's first question,
  or `terminal <n>` before one, and an `×` that deletes it. Each `+` opens another new terminal, blank,
  with its own `new terminal` tab. That tab stays while the operator moves to other tabs and across reloads, keeping
  its scope and settings, until its first question turns it into a Session or its `×` closes it. Text typed at any
  terminal's prompt and not sent stays with that terminal, and the open tab stays open after a reload; the browser
  keeps both.
- **Terminal**: the operator's question as `> <text>`, `step` parts as dim `●` lines, Results as monospace tables,
  the Comparison under `■ Compared on <key> = <value>` with marked rows in the accent colour, then the summary. The
  prompt is the last line: `>` and an input. Enter sends. The prompt keeps the cursor: a click anywhere in the terminal moves it there, and it comes
  back when a run ends. While a run is going, the input reads "The agent is working…".
- **Model, Effort and Access** sit as chips at the right of the tab row; their lists open downward. A change shows at once. A new terminal shows them too, starting from the defaults in Settings › Agents, and its Session starts with what they show. A pending Approval shows under that bar.
- **Loading**: "Reading Dev tools…". **No Connections**: the empty state with the link to Settings › Dev tools,
  as today. **Error**: the message in the terminal in the accent colour.
- **Departure from the design**: the Comparison block and Copy JSON are new; the design has per-Connection tables
  only. The chips and a pending Approval sit above the terminal, in the light theme, rather than inside it.

## Rejected

- **Reading MCP tool results in the console**: every server answers in its own text shape (dbhub JSON, Mongo
  EJSON, Redis lines), so the console would need a parser per server and still could not match rows across them.
- **An in-process render tool the agent calls**: each call would be an MCP tool call, so it would write Action Log
  rows and pass through the PROD-write classifier as an unknown tool.
- **A merged table only**: hides which Connection said what, which is the point of the Comparison.

## Glossary

- **Result**: the rows one Connection gave for one question, shown as a table under the Connection's name.
- **Comparison**: the agent's match of Results from two or more Connections on one key, one row per field, with the
  rows that differ marked.

## Seams

- **Backend + SQLite, over HTTP and WebSocket** (fake agent SDK): 5, 7, 9, 10, the caps, `differs`, and the
  appended instructions on a `devtools` run. 2, 4, 6, 12 and 13 stay covered by `09-dev-tools-agent`'s tests.
- **Browser** (Playwright, with the API answered by the test): 1 to 3, the Result and Comparison tables, 8 and 11.

## Out of scope

- Charts or saved queries.
- Comparing across questions or over time.
