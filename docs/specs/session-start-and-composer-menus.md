# Session start on any branch, and composer menus

**Status:** shipped
**Design:** none. The New Session card keeps its layout. The composer's toolbar holds one settings pill; the design's Workspace screen is not redrawn.

## Problem

Starting a Session on a branch the Repo's own folder had checked out failed with "is checked out in the Repo's own folder.
Switch that folder to another branch, then try again". The operator had to leave the console to start work. A branch that
only origin has needed a pull request first, and a new branch could only be made after the Session started. The red error
also stayed after the operator picked another branch.

In the composer, files could not be mentioned from the keyboard, and the placeholder gave no hint of the menus.

## Behavior

1. The branch list of a new Session shows the Repo's local branches, then the branches only origin has, tagged `on origin`.
   The list fetches origin first; with no reachable origin it shows what was last fetched.
2. A branch the Repo's own folder holds starts a Session on a detached HEAD at that branch's commit, moved forward to
   origin when behind. The Session keeps the branch's name. The folder keeps its branch and its changes.
3. A branch only origin has is fetched and made a local branch tracking it, then the Session starts on it.
4. A name typed into the branch list that no branch has offers "Create <name>". Start makes the branch at the newest commit
   of the Repo's default branch, fetched from origin, and the Session starts on it.
5. Switching an idle or failed Session to a branch the Repo's own folder holds detaches its worktree at that
   branch's commit the same way.
6. An error from Start clears when the operator picks or creates another branch.
7. The composer placeholder reads `Ask anything. @ files, $ skills, / commands`, except while the agent works.
8. `$` as the first character opens the skills menu that `/` opened before. A pick writes `$name` and keeps the note. A typed
   `$name` or `/name` that matches a skill runs it, as before.
9. `/` as the first character opens a commands menu: `stop` while the agent works, `diff` when the Session has changes, `pr`
   when a pull request can be opened, `skills` and `files`, which open those menus. Picking a command clears the message and
   runs it. Text that matches no command, such as an old `/skill-name`, sends as typed.
10. `@` at the end of the message, at its start or after a space, opens a files menu narrowed by the letters after it.
    Names that start with the letters come first, then names that hold them, then paths that do; shorter paths first. Files
    git ignores are not listed.
11. A Repo Session lists the files of its own worktree, each with its name and folder. An Anonymous Session lists the files
    of every imported Repo, each tagged with its Repo's name.
12. Picking a file writes its path after the `@`: relative to the worktree in a Repo Session, absolute in an Anonymous one,
    in quotes when it holds a space.
13. Arrows move, Enter or Tab picks, Escape closes until the text changes, in all three menus. With no row, Enter sends.
14. The menus show only in a Repo Session and an Anonymous Session. A `pr_review` or dev-tools Session shows none.
15. The composer's toolbar holds Attach and the Repos icon on the left, and on the right one settings pill, then Send
    (Stop and Queue as before). A second row under the message box does not exist.
16. The pill reads the model's short name and the effort, such as `Sonnet 5.5 High`, with the Claude mark. It opens one
    popover over the message box, no wider than the box except in a very narrow Session column, which it still fits.
17. The popover has a search box (focused on open) over the model list, the effort list under `Reasoning`, and a footer chip
    that names the Session's Access mode. The chip opens four icon buttons in order of trust: lock for Supervised, pencil for
    Auto-accept edits, sparkle for Auto, shield-off for Full access. The picked mode's name and description show under them,
    worded as the terminal's Access dropdown words them.
18. A pick saves at once and applies from the Session's next run. The popover stays open for the next pick.
19. Typing narrows the models; Enter picks the first match. Down arrow leaves the search box for the list, arrows walk a
    list, Escape or a click outside closes the popover and returns the focus to the pill.
20. The Repos icon shows a count when other Repos are open to the Session. Its tooltip names the choice: `Repos: this one`
    or `Repos: this one, admin-panel`. It opens the same list as before.
21. The pill shows no context-used chip: the console holds no per-Session context usage.

## Settled

- **Detached, not refused**: git allows one checkout per branch. The Session detaches at the branch's commit, as it already
  does for the default branch, and the agent makes a branch for its fix.
- **A new branch is explicit**: the request says `new_branch`; a name no branch has and no flag still fails validation.
- **File list**: read with `git ls-files` (tracked plus untracked, ignore rules applied), kept five seconds per folder, 30
  rows at most.

## Not required

- **Fresh remote branches without a network**: the list shows the last fetch.
- **Commits on a detached branch Session reach the branch**: they do not; the agent switches to a branch of its own first.

## Safety

No change. Creating a branch and fetching run in the daemon, logged in the Action Log as git actions.

## API

### `GET /repos/:id/branches`

Each branch gains `remote`: true when only origin has it. Local branches come first.

### `POST /sessions`

A `repo` Session takes `new_branch`: true to make `branch` at the newest default branch. `from_origin` is as before.

### `GET /file-menu?session_id=&q=`

`{ data: { items: [{ path, name, dir, repo }] } }`. `repo` is null in a Repo Session. 404 for an unknown Session; an empty
list for a Session kind with no menu.

## UI

The New Session card's branch list, the composer's three menus and its settings popover. States: reading, error, no match.

## Rejected

- **A commands list in the daemon**: the commands are actions of the page the Session is on, so they live in the page.
- **Refusing a branch the folder holds, with advice**: the operator's goal is a Session, not a lesson in worktrees.
- **A provider rail in the popover**: Claude is the only provider, so a rail would hold one icon that does nothing.
- **Model, Effort and Access as separate chips with a second row under the box**: three menus and two rows of chrome for
  settings the operator changes a few times a day.

## Seams

- **Backend + SQLite** (`workspace.test.ts`): 1 to 5, 10 to 12.
- **Backend + SQLite** (`skill-kinds.test.ts`): 8.
- **Browser** (`skill-kinds.spec.ts`): 8, 9, 10, 13.
- **Browser** (`workspace.spec.ts`): 15 to 20.
- **Browser** (`session-card.spec.ts`): 16, at a wide and a narrow window.
