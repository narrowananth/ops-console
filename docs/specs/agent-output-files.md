# Agent output files

**Status:** shipped
**Design:** none. Reuses the attachment viewer and file chip of Workspace.

## Problem

The agent makes a file the operator wants to see: a PDF, a spreadsheet, a chart, a zip. The Run sandbox blocks `open`, so
the agent can only print a path and tell the operator to run `open` in their own terminal. The console shows nothing.
The operator may also tell the agent to put the file somewhere, such as `~/Downloads`. The sandbox blocks that write, so
the agent can only print an `mv` command.

## Behavior

1. Each Session has an output folder. The agent is told its path and to write every file meant for the operator there,
   and not to run `open`, `xdg-open` or `start`.
2. A run's commands may write in the output folder. They may read it too. Nothing else outside the working folder, temp
   and tool caches opens up; the Run sandbox's other limits stand.
3. A file the agent writes in the output folder shows in the Session's transcript as a chip with its name and size, on
   the message of the turn that wrote it. A file rewritten in a later turn shows on that later turn's message only.
4. A chip opens the file over the page, as an attached file does: an image or PDF as itself, text as text, any other type
   (spreadsheet, zip, document, HTML, SVG) as a Download. Nothing the agent wrote ever renders as a page or script in the
   console.
5. Download keeps the file's own name.
6. The chip shows after a reload and in another tab, because the daemon keeps the list, not the page.
7. A file the agent names in text but did not write in the output folder gets no chip. The agent's text stays as it is.
8. A turn that is still running shows no chips; they appear when it ends.
9. Two Sessions have separate folders; a file of one never shows in the other.
10. An output file is kept as long as its Session. Deleting the Session deletes its output folder.
11. A Session with no output files has no chip. A run that fails mid-way still shows the files it wrote before it
    failed.
12. The operator tells the agent to save an Output file in a folder, such as `~/Downloads`. The agent calls the console's
    `save_file` tool with the file's name and the folder's path, absolute or under `~/`. The tool raises an Approval in every Access
    mode. It shows the file, its size and the full destination path.
13. On the operator's yes, the daemon copies the file to the folder under the same name and the tool answers with the
    path it wrote. The Output file stays in the output folder, so its chip still opens.
14. On the operator's no, nothing is copied and the tool tells the agent it was denied. The agent does not retry another
    way, such as a command, and does not ask the operator to run `mv`.
15. A folder that does not exist, a path that is a file, a relative path, or a symlink at the destination name gives the agent an error and raises no
    Approval. The daemon never makes a folder. A file of the same name in the folder is replaced; the card shows the
    destination, not whether the name is taken.
16. The tool takes only a name from the Session's output folder. A path, `..` or a file elsewhere on this Mac is refused.
    The agent saves a file it wrote elsewhere by writing it in the output folder first.
17. A run the operator started offers `save_file`. A job the console starts, a review of pull request text and a thread
    answer have no output folder and offer none.
18. An Approval waits like any other: the run shows Waiting for approval, the Agent runs page counts it under needs you,
    and a reload keeps it.

## Settled

- **Open how**: in the console only. The daemon never runs `open` on an agent file, so a `.app`, `.command` or
  `.terminal` file cannot start from a click.
- **Which files**: only the Session's output folder. The console serves no other path on this Mac.
- **Save where**: anywhere the operator names, through an Approval. The sandbox's write list does not grow; the daemon,
  outside the sandbox, does the copy, as it does for pushes and pull requests (ADR 0006).
- **Copy, not move**: the file stays in the output folder. A move would break the chip and the history.
- **Type**: the viewer's existing rule decides how a file shows: image and PDF as themselves, text as text, everything
  else as bytes to download.
- **Name**: the agent's file name is kept in the folder, unlike an attachment, because the agent picks it. The daemon
  serves only a bare file name that is in the folder, never a path.

## Not required

- **Open in the default Mac app** from the console. The operator downloads, then opens it themselves.
- **Moving or copying any file** that is not an Output file. The agent has no way to place a file it did not write in the
  output folder.
- **Cleanup when a Repo is removed.** The Sessions it takes with it leave their output folders in the data folder.
- **Subfolders.** A file in a subfolder of the output folder gets no chip.
- **Live chips** while a turn runs. They appear when the turn ends.

## Safety

The agent gains one tool, `save_file`. It never writes outside the working folder, temp, caches and the output folder
itself; only the daemon writes the destination, and only after the operator's yes on that exact path. The Run sandbox's
write list is unchanged.

The agent gains write access to one more folder, under the data folder, and the daemon serves what it holds. The
sandbox still denies reading the rest of the data folder, `runtime.json` included. The folder holds files only: the
daemon serves no symlink and no file with a second hard link, and opens the file itself rather than trusting an earlier check, since the agent can swap a name between the two. It never writes through a symlink at the destination. A file's bytes reach the console with a type that never renders as a
page. No new command, connection or network host. PROD rules unchanged.

## API

### Common

`OutputFile`:

- `name`: file name in the folder.
- `size`: bytes.
- `modified_at`: the time it last changed, as an ISO string. The page gives the file to the last agent message that
  started at or before this time.

| Status | Error code  | When                                              |
| ------ | ----------- | ------------------------------------------------- |
| 404    | `not_found` | Unknown Session, or a name that is not in its folder |

### `GET /sessions/:id/outputs`

Returns `{ data: OutputFile[] }`, files only, A to Z by name.

### `GET /sessions/:id/outputs/:file`

Streams one file with the viewer's type rule and `inline` disposition. A name with `/`, `..` or a leading dot, or a
symlink, is `not_found`.

### Approval for `save_file`

A `command` Approval of the existing list and decision endpoints. Its summary reads `Save <name> (<size>) to <folder>/`.

## UI

The Approval card names the file, its size and the destination, and offers Approve and Deny like any other.

The transcript's turn message gets a row of chips under the text, the same chip as Attached files. Click opens the
attachment viewer with the output address. No chips and no row when the turn wrote nothing. A file gone from disk shows
the viewer's error line.

## Rejected

- **`open` in the daemon**: runs the file with the operator's access; a `.command` or `.app` is code.
- **Serve any path under temp or the working folder**: a path guard for symlinks and `..`, and reads of files the
  operator never meant to show.
- **Widen the sandbox's write list** to `~/Downloads` or any path: a run steered by log text would write there too, and
  the sandbox cannot tell the operator's words from injected ones. ADR 0006 rejects a Setting or an unsandboxed retry.
- **A Save to button only**: the operator still has to click each time, and the agent cannot finish the job they asked for.
- **Tell the agent to print `open <path>` for the operator**: what happens today.

## Glossary

- **Output file**: a file the agent wrote in its Session's output folder for the operator, shown in the transcript and
  opened in the console, never launched on this Mac.

- **Save file**: the Approval of a tool that copies an Output file to a folder the operator names, from the agent's
  `save_file` call.

## ADR

- **Operator approves agent never merges** (0002): rewrite in place. The agent also saves a file outside its folders
  only by asking: `save_file` raises an Approval in every Access mode, and only the operator's yes has the daemon copy it.
  The sandbox's writes do not grow. Considered Options gains "widen the sandbox's write list", with why it lost.

## Seams

- **Output folder and file list** (unit): 2, 3, 7, 8, 9, 11.
- **Output file API** (backend + SQLite): 5, 6, 10, and the `not_found` rows of API.
- **Run sandbox settings** (unit): 2.
- **Agent prompt** (unit): 1.
- **Save file tool and Approval** (backend + SQLite): 12, 13, 14, 15, 16, 17, 18.
- **Transcript chips** (frontend component): 3, 4, 6, UI.

## Out of scope

- Open in the default Mac app, behind its own type blocklist and click. A later spec.
- Files from Datadog, MCP servers or other tools. They are not the agent's own output.
