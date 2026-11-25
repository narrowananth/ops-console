# Pull request diff and spacing fixes

**Status:** shipped
**Design:** Pull requests page, Files changed (`design/workspace-pr-bitbucket.html`), the sidebar (`design/ops-console-sidebar.html`), Accounts & Usage.

## Problem

Seen in daily use after the console UI batch:

- On Accounts & Usage, "On this machine" sits flush against the Notifications card; every other section has a gap.
- In Files changed, the three-dot Delete menu on a comment does not open, though it does on Overview.
- The file tree is plain text with small triangles, where Bitbucket draws guide lines for each level.
- The hover tip on a file in the tree runs past the edge of its own bubble on a long path.
- A comment box opened on a diff line runs off the right edge, so Cancel and Add comment are cut off. A thread under a line is cut the same way, and code inside it does not wrap.
- The selected sidebar item's shadow and the hovered item's background touch.
- Atlassian's MCP server at `https://mcp.atlassian.com/v1/mcp` is deprecated and goes away on 2027-03-01; its stable address is `https://mcp.atlassian.com/v2/mcp`.

## Behavior

### Spacing

1. Accounts & Usage leaves the same gap above "On this machine" as between its other sections.
2. In the sidebar, two neighbouring items never touch: the selected item's shadow and the hovered item's background are 6 px apart or more, expanded and folded.
3. In the Files changed tree, rows are separated the same way, so the selected file's shadow and a hovered file do not merge.

### Files changed

4. A comment's three-dot menu opens in Files changed as it does on Overview, wherever the file sits on the page, and its Delete works.
5. The file tree draws a vertical guide line for each level of folder, joined to its rows, and a folder row shows a chevron that points down. Files at the top level have none.
6. Hovering a file in the tree shows a tip with the full path, wrapped inside its bubble at the slashes, never running past the bubble's edge. This holds for every tip in the console.
7. A comment box on a diff line is as wide as the visible part of the diff, up to 56 rem, and stays at the left edge when the diff is scrolled sideways. Cancel and Add comment are always visible.
8. A thread under a diff line follows the same width, and code and long words in it wrap inside the card.

### Atlassian

9. Connecting Jira or Bitbucket registers the Atlassian MCP Server at `https://mcp.atlassian.com/v2/mcp`.
10. Connecting again when the server is registered at another address registers it at the current one, whatever the Connector is. A registration at the same address is left alone, with its sign-in.

### What must not regress

11. The Connectors' other servers, Sessions, the Pull requests page's Overview and the sidebar's collapse behave as before.

## Settled

- **Guide lines**: drawn with the row, one per depth, not by a separate layer.
- **Menu**: it renders in the page body, not in its parent, so a clipped or contained parent cannot cut it. This applies to every `MenuButton`.
- **Tip wrapping**: text wraps at slashes first and anywhere when it must. A tip's text content is unchanged.
- **Existing registrations**: a server registered at the v1 address moves to v2 when the operator connects again; the console does not move it on its own, since the new address asks for a new sign-in.

## Not required

- **A folder that folds** in the tree, or a status icon per file: the tree keeps its rows as they are.
- **Moving v1 registrations on start**: until the operator reconnects, a v1 registration keeps working until Atlassian turns it off on 2027-03-01.

## Safety

No change.

## Seams

- **Sidebar and tree spacing, Accounts & Usage gap** (frontend e2e): 1 to 3.
- **Comment menu in Files changed** (frontend e2e): 4.
- **File tree and tip** (frontend e2e): 5, 6.
- **Diff comment box and thread** (frontend e2e): 7, 8.
- **Atlassian address** (backend): 9, 10.
- **Regression**: 11 by the existing tests.

## Out of scope

- Rows that fold in the file tree, and per-file status icons.
