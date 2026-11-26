# Output files list, file tree picks and file menus on Files changed

**Status:** shipped
**Design:** none (the Session panel and Files changed as shipped)

## Problem

A Session that writes thirty Output files pushes the rest of the Session panel below the fold. On Files changed, a click
on a file in the tree does nothing while every file is collapsed, and a collapsed file's three-dot menu draws nothing
past its own header, so the operator cannot pick a view or open the file in source.

## Behavior

### Output files

1. The Session panel lists the five newest Output files. A Session with five or fewer shows them all and no button.
2. With more than five, a button under the list reads "Show N more", N being the files not shown. It carries
   `aria-expanded` false. A click lists every file, newest first, and the button reads "Show less" with `aria-expanded`
   true. A click on it lists five again.
3. The list is folded again when the panel shows another Session.
4. A row still opens the Viewer.

### File tree

5. After Collapse all, a click on a file in the tree opens that file's diff, scrolls it to the top of the list and marks
   it the active file. The other files stay collapsed.
6. With the diffs open, a click scrolls to the file as before.

### File menu

7. The three-dot menu of a file header opens whether the file is open or collapsed. It lists View side-by-side or View
   unified, View entire file or View changes only, and Open in source, each fully visible and the topmost thing at its
   own centre, over the file below.
8. A click on View side-by-side or View entire file closes the menu and opens the file's diff. Open in source closes the
   menu and opens the file on the Git host in a new tab.
9. Escape, a click outside, a scroll or a resize closes the menu. The three-dot menus of comments and the Session's
   menus behave as before.

## Settled

- **Menu**: the file menu is the floating menu of the comment three-dot menu, drawn in the page body. The section's
  `overflow-hidden`, which rounds the file's corners, no longer clips it.
- **Count**: five Output files show before the button, as three pull requests do.
- **Button name**: "Show N more output files" and "Show less output files" are the accessible names, so they differ from
  the pull request list's buttons in the same panel. The visible text is "Show N more" and "Show less".
- **Pick**: a pick is one request to one file; the files keep their own fold.
- **Look**: the file menu button is the bare square of the comment menu, no border.

## Not required

- **Output files kept open** across a reload or a Session change: the list is folded again.
- **Show more in steps**: one click shows all of them.

## Safety

No change.

## Seams

- **Session panel** (browser): 1, 2, 3, 4. Pinned by `output-viewer.spec.ts`; 3 follows from the state being keyed by
  Session and is not driven separately.
- **Files changed** (browser): 5, 6, 7, 8, 9. Pinned by `pr-thread-actions.spec.ts`; 6 by the existing tree test and 9
  by the existing comment menu test; Escape, scroll and resize closing are `MenuButton`'s own and not driven here.
