# Session start on any branch, and composer menus

**Status:** shipped
**Design:** none. The New Session card and the Session composer keep their layout; the menus follow the skills menu that was already above the composer.

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

The New Session card's branch list and the composer's three menus. States: reading, error, no match.

## Rejected

- **A commands list in the daemon**: the commands are actions of the page the Session is on, so they live in the page.
- **Refusing a branch the folder holds, with advice**: the operator's goal is a Session, not a lesson in worktrees.

## Seams

- **Backend + SQLite** (`workspace.test.ts`): 1 to 5, 10 to 12.
- **Backend + SQLite** (`skill-kinds.test.ts`): 8.
- **Browser** (`skill-kinds.spec.ts`): 8, 9, 10, 13.
