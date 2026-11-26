# Output viewer

**Status:** shipped
**Design:** none. Extends the attachment viewer and the file chip of Workspace.

## Problem

The agent's output files open in a popup that shows images, PDFs, HTML and plain text, and nothing else. Markdown shows
as raw text, JSON as one long line, CSV as commas, and a Mermaid or Graphviz diagram as source. The operator who asks a
Session for data, a report or a flow chart cannot read it without downloading it. Code blocks in a message cannot be
opened at all.

## Behavior

1. A click on a file chip opens the Viewer, the popup over the page. It shows the file by its type, rendered by default,
   with a Source toggle for every type that has one, plus Copy, Download and Close. Escape, Close and a click on the
   dimmed page close it.
2. **Markdown** (`.md`, `.markdown`): headings, paragraphs, lists, tables, task lists, block quotes, code blocks and
   inline code, bold, italic, strike and links. Raw HTML in it shows as text. A remote image is not loaded: it shows as
   its alt text and address. A link opens in a new tab with no referrer on the operator's click.
3. **JSON** (`.json`, and `.jsonl` as one entry per line): a collapsible tree, first level open, with Expand all and
   Collapse all, and keys, strings, numbers and nulls told apart by colour. JSON that does not parse shows its source with
   the parse error and its line.
4. **Query result**: a JSON file or code block holding one `ops-result` object shows as the Dev tools Result table, with
   its Connection, query, row count and time, instead of a tree.
5. **CSV and TSV**: a table with a sticky header row and a click on a header to sort. The first 1000 rows show, with the
   total, and Download has them all.
6. **Mermaid** (`.mmd`, `.mermaid`): the diagram drawn as an image, as flow charts, sequence, state, ER, class and Gantt
   charts. A diagram that does not parse shows the parser's message and the source.
7. **Graphviz** (`.dot`, `.gv`): the graph drawn as an image. A graph that does not parse shows the message and the
   source.
8. **HTML, SVG, images, PDF, video, audio and other text** show as they do now. HTML and SVG run no script and reach no
   network. A type with no preview offers Download.
9. A file larger than 2 MB shows its first 256 KB as source with a note, and Download has the rest, as now. A rendered
   type never half-parses a cut file.
10. A fenced block in an agent message with the language `json`, `jsonl`, `csv`, `tsv`, `markdown`, `md`, `mermaid`, `dot`,
    `html`, `svg` or `ops-result` shows an Expand button beside its Copy button. It opens the same Viewer on the block's
    text, named by its language (`block.json`). Download saves the text with that extension.
11. The Session panel lists every Output file of the Session, newest first, with name and size. A click opens the Viewer.
    The list matches the chips after a reload and in another tab, and is empty with no Output files.
12. The agent is told the types the Viewer draws: write a table or rows as `.csv` or `.json`, a report as `.md`, a flow or
    sequence as `.mmd`, and a graph as `.dot`, in its output folder.
13. Opening a file that is gone, or one that fails to load, shows the Viewer's error line. A renderer that fails to load
    shows the file's source with Download.
14. The Mermaid and Graphviz drawing code loads only when such a file is first opened. A page that never opens one
    downloads none of it.
15. What must not regress: an attached file, a pasted image and an Output file of any current type open as before; nothing
    the agent wrote renders as a page or script in the console.

## Settled

- **Rendered by the page, shown as an image**: Mermaid and Graphviz output becomes an SVG that shows in an `<img>`, which
  runs no script, as an SVG file does now.
- **Markdown by our own renderer**: no raw HTML, no remote loads. A library that passes HTML through would need a
  sanitiser to match.
- **Strict Mermaid**: its strict security level, no click handlers and no HTML labels.
- **One Viewer**: attachments, Output files and code blocks share it, so a new type works in all three.
- **JSON and CSV need no library**: parsed in the page; the 2 MB cap bounds the work.

## Not required

- **Editing** a file in the Viewer, or saving a change.
- **Interactive HTML** (a chart that needs script). It shows its source, with Download.
- **A diagram shown inline** in the message body. It opens in the Viewer.
- **Search inside a JSON tree**, and paging past the first 1000 rows of a CSV.
- **Subfolders** of the output folder (`agent-output-files`).

## Safety

The Viewer renders only what the daemon serves from the Session's output folder, or text already in a message. Nothing it
draws runs script or loads a remote address: the HTML frame keeps no `allow-*` token and a CSP that blocks every request,
Markdown drops raw HTML and remote images, Mermaid and Graphviz draw to an image. A link needs the operator's click. No
change to the agent's reach, the daemon's routes or any Connection.

## API

None. The file list and download are `agent-output-files`' `GET /sessions/:id/outputs` and `GET /sessions/:id/outputs/:file`.

## UI

- **Viewer**: the existing popup, with a Rendered / Source toggle in its header beside Copy and Download. A table, tree and
  diagram fill the body; a wide table scrolls inside it. A diagram has zoom in, out and fit.
- **File chip**: gets a small icon for the type, as the chips of attachments have.
- **Code block**: an Expand button beside Copy for the languages in 10.
- **Session panel**: an Output files section (Behavior 11).
- States: Opening, Could not open (error line), Parse error (message with source).

## Rejected

- **Script in an opaque frame, for interactive charts**: the agent could run script in the console's tab.
- **A Markdown library that allows HTML**: an extra sanitiser to keep correct for a small gain.
- **Converting files on the daemon**: a render path in the daemon that reads agent-written files; the page can do it with no
  new route.

## Glossary

- **Viewer**: the popup over the page that opens an attached file, an Output file or a message's code block, rendered by
  type with a Source toggle, and never runs the file's script.

## Seams

- **Viewer rendering** (frontend component): 1 to 9, 13 to 15.
- **Code block Expand** (frontend component): 10.
- **Session panel list** (browser, against the outputs API): 11.
- **Agent prompt** (unit): 12.
- **Lazy load** (browser, network log): 14.

## Out of scope

- Editing, interactive HTML, inline diagrams, JSON search, CSV paging. Each is its own spec.
