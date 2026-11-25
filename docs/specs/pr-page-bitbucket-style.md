# Pull request page in the Bitbucket style

**Status:** shipped
**Design:** `design/workspace-pr-bitbucket.html`, frames 2 and 3. Departure from `design/ops-console-sidebar.html`: Activity shows threads with their code, Files changed gets a tree and menus and drops the rail.

## Problem

Activity lists comments flat, so the operator cannot tell which line a comment is on without opening Files changed. Files changed has no tree, no list of comments to jump between and no sort. The right rail takes width from the diff. Check replies and Address comments only exist for all threads at once, not on the thread being read.

## Behavior

### Activity

1. Overview's Activity lists events and threads in time order, newest first, with the day as a divider ("Today", then dates). An event is a commit pushed or the newest Agent Review. A thread is a root comment with its replies.
2. A thread on a line or a file is one card: a header with the state (`open` or `resolved`), the file and line; the code the comment is on, which is the diff hunk with the line marked; then the comments, then the actions. A general comment has no file and no code. A thread whose line the newest commit moved says `Outdated`.
3. A resolved thread folds to its header and opens on click. Open threads start open. The fold is remembered per thread in this browser.
4. A filter on the Activity header, the console's own dropdown: All activity, Open threads, Resolved threads, Agent only. It opens on Open threads, marked `default` in the list, and is not kept across pages.
5. The actions on an open thread are Resolve, Reply, Check reply and Address comment. On a resolved thread: Unresolve and Reply. Each comment of the operator's has a three-dot button whose menu has Delete; it asks to confirm, then deletes that comment. Others' comments have no button. Check reply shows when the thread has a reply and its last comment is not the agent's. Address comment shows on an open thread. Both send the one thread to the PR Session (see one-session-per-pull-request). While the PR Session is working, they are disabled with "The Session is working on this pull request".
6. The rail's Address comments and Check replies stay.

### Files changed

7. The right rail is not shown on Files changed. Overview and Commits show it again. The choice is not remembered: the rail is tied to the tab.
8. Files changed has a bar with a Comments menu, a Sort menu, Expand all, Collapse all and the viewed count. "All changes" is not shown.
9. The Comments menu reads "Comments (N unresolved)". It opens two lists, Unresolved Comments and Resolved Comments, each with its count and a fold. A row shows the author, the age, the file and the first line of the comment, and `Outdated` when it is. A row click closes the menu and scrolls to that thread in the diff, opening its file.
10. The Sort menu has File tree and Recent comments. File tree lists folders then files, A to Z. Recent comments lists files by the time of their newest comment, newest first, then files without comments in tree order. The choice is remembered in this browser.
11. A file tree sits left of the diff. It follows the Sort choice. A file shows its +/− and a count of its unresolved threads. A click scrolls the diff to the file and marks it. The tree folds to a strip.
12. A thread in the diff shows the same comments and actions as in Activity.

## Settled

- **Rail on Overview and Commits only**: the diff needs the width. Everything the rail does is reachable from a thread or from Overview.
- **Agent only filter**: shows threads the agent started or replied in, so the operator can read what it did.
- **Outdated**: from the Git host's own flag when it gives one; otherwise a comment whose line is not in the newest diff.

## Not required

- **Description edits and earlier Agent Reviews as events**: the Git hosts give no description history, and the page holds the newest review only.
- **Keyboard jumps between threads**: not in this change.
- **Draft comments saved on the host**: the page keeps its local drafts.

## Safety

No change. The thread buttons start a Round exactly as the rail's buttons do, and the console posts as before.

## API

No new endpoint. `comment_ids` is also accepted for `check_replies`, naming the threads to check; each must be an unresolved thread with a reply that the agent did not write last, else `validation_failed`. A thread's comment records carry what the page needs: the file, line, hunk, `outdated` and `resolved`. `GET` of a pull request adds `outdated` and `hunk` to each comment when the host gives them; Git hosts that do not give a hunk get none, and the card shows the file and line only.

## UI

Overview, Files changed. States: loading, a pull request with no comments ("No comments yet. Open Files changed, hover a line and press + to comment on it."), a filter with no match ("No thread in this view."), a hunk the host did not give (card without code), the PR Session working (thread buttons disabled).

## Rejected

- **Keep the rail on Files changed and let it fold**: still costs the width until the operator folds it, on every pull request.
- **A separate Comments tab**: the Comments menu reaches the same threads from the diff, where they are read.

## Seams

- **Browser** (`frontend/e2e/pr-thread-actions.spec.ts`, with the host and agent faked in the daemon): 1 to 5 and 7 to 12.
- **Backend + SQLite** (`backend/test/pr-actions.test.ts`, `pr-comment-fields.test.ts`): `comment_ids` for Check replies; `outdated` and `hunk` from each host.

## Out of scope

- Keyboard navigation between threads.
