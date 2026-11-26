# Pull request file tree: fold folders, hover without a tip

**Status:** shipped
**Design:** Pull requests page, Files changed (`design/workspace-pr-bitbucket.html`).

## Problem

Seen after [pr-diff-and-spacing-fixes](pr-diff-and-spacing-fixes.md):

- A folder in the Files changed tree cannot be folded or opened, so a large pull request is one long list.
- Hovering a file shows a tip with its path, which sits over the next rows and adds nothing the tree does not show.
- The hovered and the selected row's background covers the folder guide lines to its left, so the lines break at that row.

## Behavior

1. A folder row folds and opens on a click, and on Enter or Space when focused. Its chevron points down when open and right when folded. Folding hides every folder and file below it, at any depth, and opening shows them as they were.
2. A folded folder keeps its own folded or open state when a parent folds and opens again.
3. The folder state is per pull request tree and lasts while the page is open. A reload opens every folder.
4. A file inside a folded folder that is the open file stays open in the diff; the tree row is hidden until the folder opens.
5. Sort by Recent comments is a flat list with no folders, so nothing folds there.
6. Hovering a file or folder row shows a background and no tip. The file's name is the row's accessible name.
7. A row's hover or selected background starts to the right of the guide lines, so every line runs unbroken past it, hovered, selected or not.
8. What must not regress: the guide lines, the chevron, the gap between rows, the thread count and the +/- counts, picking a file, Fold the tree to a strip, and the tip of every other element, including its wrapping at slashes.

## Settled

- **Fold state**: kept in the page, not stored. A pull request opens fully unfolded, as it did.
- **Tip**: the file row's `title` is removed. The tip layer is unchanged.
- **Background**: the row is indented by a margin, not by padding, so its background does not reach the guide lines.

## Not required

- **Fold all and Open all for the tree.** The bar's Collapse all and Expand all fold the diffs, not the tree.
- **Remembering folded folders** across a reload.
- **The full path on hover.** A name cut by the tree's width shows in full in its diff header.

## Safety

No change.

## Seams

- **Tree fold and hover** (frontend e2e): 1 to 7.
- **Tip wrapping on another element** (frontend e2e): 8.
- **Regression**: 8 by the existing tests.

## Out of scope

- Fold all and Open all for the tree, remembered fold state.
