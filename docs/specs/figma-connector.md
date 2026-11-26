# Figma Connector, read only

**Status:** shipped
**Design:** the Connector pane of Integrations (`design/ops-console.html`), as for Sentry: a numbered sign-in step and Disconnect. No new screen.

## Problem

The operator works from Figma designs and wants a Session to read them: look at a frame, take its layout, text, variables and
styles, read the comments, and then change the code. Today they describe the design in words or paste screenshots. Figma has
an MCP server for this, but the console has no Connector for it, so it is not one click away and has no status.

The operator wants the Session to read Figma and never write to it: no frame created, edited or deleted, no file made, no
mapping saved.

## Behavior

1. Integrations lists Figma as a seventeenth Connector, after the sixteen that exist, with status `off`.
2. Connect takes no body. It registers the `figma` MCP Server at Figma's hosted address in every account if it is missing,
   turns it on if it was turned off, and starts the browser sign-in through Claude Code in the active account. The operator
   types nothing in the console. The Connector's status follows the server's.
3. A Session's own runs (the operator's messages) can call the Figma tools on the read list: `get_design_context`,
   `get_screenshot`, `get_metadata`, `get_variable_defs`, `get_figjam`, `get_comments`, `get_code_connect_map`,
   `get_code_connect_suggestions`, `get_context_for_code_connect`, `get_libraries`, `search_design_system`,
   `get_motion_context`, `get_shader`, `list_shaders`, `list_file_shaders`, `get_generative_plugin`,
   `list_generative_plugins`, `download_assets`, `export_video` and `whoami`.
4. A call to any other tool of the Figma server is refused before it runs, in every Access mode, `full` included. No
   Approval is raised. The agent is told Figma is read only here and that nothing was changed. This holds for the tools that
   write today (`use_figma`, `generate_figma_design`, `html_to_figma`, `send_code_to_figma`, `upload_assets`,
   `add_code_connect_map`, `send_code_connect_mappings`, `create_new_file`, `generate_diagram`, `generate_image`,
   `generate_vector_illustration`, and the plugin and shader create and update tools) and for any tool Figma adds later,
   until the read list names it.
5. The agent is told, in the Session's instructions, that Figma is read only and which tools it has.
6. The refused tools are not offered to the agent at all when the run starts, so it does not plan around them. A call that
   still arrives is refused as in 4.
7. A job the console starts (Verify, Fix, a pull request review, reply or comment pass, Open pull request) does not reach
   Figma, as it reaches no Connector server of this kind.
8. Each Figma call shows in the Session as a step naming the tool, as other MCP tools do.
9. Figma may refuse a call: no seat that allows it, a plan without access, a rate limit (Professional seats get 200 calls a
   day and 10 a minute; View and Collab seats 20 a month; Starter plans none). The agent receives Figma's own message and the
   Connector's status does not change. The pane says what the plans allow.
10. A sign-in that Figma refuses for the console's client (Figma accepts only clients on its MCP catalog) leaves the status
    `auth` with Figma's reason, and the pane says so. The console does not present itself as another client.
11. A sign-in the operator does not finish within 5 minutes is stopped and reads `auth`. Cancel stops one that waits.
12. Disconnect removes the `figma` server and clears the Connector's stored state, as for any server Connector. It signs the
    operator out of nothing at Figma.
13. A Figma server the operator turned off in Integrations reads `fail`, "figma is turned off in MCP servers". Connect turns
    it back on.
14. No token appears in a response, event, log or the agent's prompt.
15. Two Sessions with Figma connected both read it, and each Session's calls are its own.
16. What must not regress: the other sixteen Connectors, the MCP servers page, Sessions while Figma is not connected (no
    server starts and the agent is told nothing about Figma), and Disconnect of Jira or Bitbucket, which share another server.

## Settled

- **Read only is the operator's choice** and holds for Figma alone: the other Connectors on the roadmap offer their writes behind an Approval.
- **Remote server only.** Figma's desktop server needs the Figma desktop app and Dev Mode and has fewer tools. It is not
  part of this release.
- **Reach**: the operator's own chat runs only, by the same scope rule that keeps other Connector servers out of jobs.
- **The read list is the guard.** Figma's server has no read-only mode. The list is kept in the console, and a tool not on
  it is refused. A new Figma tool is a deliberate edit of the list.
- **Read means it does not change the file.** `download_assets` and `export_video` read from Figma and leave a file in the
  Session's folders, not in Figma, so they are on the list. The agent's file rules (the Run sandbox) apply to what they write
  on this Mac.
- **Status follows the server**, as for Sentry, Slack and Jira: Figma has no CLI.
- **No account label** is required: the server's `whoami` is on the read list, and the pane shows a label only if the
  server reports one.
- **Fallback, not built now.** If the spike shows Figma refuses the sign-in, the next design is a console bridge on Figma's
  REST API with the operator's token, with GET calls only. It reaches files, nodes, images, comments and variables, and not
  `get_design_context`. It would be its own spec.

## Not required

- **Figma's limits enforced by the console.** The console shows what Figma answers; it counts no calls.
- **Writing to Figma in any form,** including comments and Code Connect mappings. A later spec may add a write, with its own
  Approval.
- **The desktop server and Dev Mode selection.** The remote server reads a file by its link.
- **Reading a file the operator's Figma account cannot open.** Figma refuses it, and the agent says so.
- **Figma Make and Slides writes.** Reads of Make files go through `get_design_context` and `get_comments` as Figma allows.

## Safety

The agent gains read tools of one service and no write. The guard refuses by name before the call leaves the daemon, so a
Figma file's text, a comment or a link in a design cannot steer the agent into a write: there is no tool for it to call.
The server starts only in the operator's own runs. The sign-in lives in Claude Code's store as for other hosted servers, and
no new credential is kept by the console. A file the agent downloads goes where its run may write and nowhere else. No
PROD Connection is touched.

## Database

```sql
INSERT INTO connectors (id, status, config) VALUES ('figma', 'off', '{}') ON CONFLICT DO NOTHING;
```

One migration, as `0040_connector_google` seeded the Google Connectors. Migration of existing rows: none.

## API

### `GET /connectors`

Returns seventeen Connectors in the fixed order, Figma after the log sources. Its `via` reads "Figma MCP". Its config is an
empty object, and a `PATCH` with any field answers `validation_failed`.

### `POST /connectors/figma/connect`, `DELETE /connectors/figma/sign-in`, `DELETE /connectors/figma/credentials`

Connect, Cancel and Disconnect, as for every Connector. Connect takes no body and answers 202. Errors:
`connector_not_connected` when an action needs Figma and it is not connected.

### Refusal

A refused Figma tool call is not an HTTP error. The agent receives a tool result that says the tool is not allowed because
Figma is read only here.

## UI

- **Connector pane**: Figma's brand icon, one numbered step "Sign in to Figma" with Connect, then status and Disconnect, as
  for Sentry. A note under the step: "Read only. Sessions can look at your designs and never change them. Figma's own plan
  and seat limits apply: Dev and Full seats on a paid plan, 200 calls a day on Professional."
- **States**: off, waiting for sign-in (with Cancel), connected, `auth` with the reason (including a refusal for the
  console's client), `fail` when the server is off.
- **Session transcript**: Figma calls as steps; a refused call shows the refusal text.

## Rejected

- **Allow the write tools behind an Approval.** Figma's writes depend on the plan and seat, and the operator chose reads only for this Connector. A later spec can add them.
- **A denylist of write tools.** Figma adds tools, and an unlisted new write would run. A list of reads refuses it.
- **The desktop server first.** It needs the desktop app and offers fewer tools.
- **The REST API bridge first.** It cannot give the agent `get_design_context`, which is the tool that makes design to code
  work, so it is the fallback.

## Glossary

- **Read list**: the tools of a Connector's MCP server that a run may call. The console refuses every other tool of that
  server, so a server with no read-only mode of its own is still read only.

## Seams

- **Connector list and Connect** (backend + SQLite, over HTTP, fake MCP server): 1, 2, 10, 11, 12, 13, 16.
- **Read list guard** (unit, then backend with a fake agent runtime): 3, 4, 5, 6, 7, 15.
- **Pane** (frontend e2e with the API mocked): 1, 9, 10, UI states.
- **Sign-in and a real read** (the operator's Figma account, run by hand): 2, 3, 8, 9. Neither the agent nor CI can sign in
  to Figma, so this is the spike and the closing check.

## Out of scope

- Writes to Figma, the desktop server, a REST API bridge, and enforcing Figma's rate limits. Each is its own spec.
