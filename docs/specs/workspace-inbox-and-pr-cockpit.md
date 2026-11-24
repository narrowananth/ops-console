# Workspace inbox and pull request cockpit

**Status:** shipped
**Design:** `design/workspace-variants.html` (Inbox, both tabs) and `design/workspace-pr-variants.html` (P3, Cockpit).

## Problem

The Workspace side panel is a tree of Repos, most of them empty, each with its own "+" and three-line Session rows.
Long names truncate and a Session that needs the operator is buried under its Repo. The pull request page is one
long scroll: status chips, a metadata block, five buttons, then the description, files and comments. Merge sits far
from what it depends on.

## Behavior

### Sessions

1. The list is flat and grouped by state: Needs you (waiting on a question or an Approval, or failed), Running,
   Idle. Within a group Sessions keep their last-active order.
2. A row is three lines. First: the Repo's badge and name (`No Repo` for an anonymous Session), a "Working" chip with
   the run's minutes while it runs, one word for what the Session waits on (`approval`, `question`, `failed`) and
   time since last active. Second: state dot and title. Third: the branch, the pull request mark (the number, or `+N`
   for several, coloured by the newest one's state) and the model. Stop replaces the state and time in the first line
   of a busy row on hover or focus. After a short rest on a row, a hover card shows the title, Repo and host, branch,
   what the state means, model, effort and Access mode, when it started and was last active, and each pull request
   with its title.
3. Repos with no Session do not show. Idle lists the first 8 Sessions with "Show N more"; a search, or the open
   Session, lifts the limit.
4. Tabs filter by state (All, Needs you, Running; a count shows when it is above zero) and a Repo picker on the same
   line narrows to one Repo or to No Repo. Tabs and the picker are remembered in this browser.
5. A group's header folds the group and keeps its count. Folds are remembered in this browser, for both lists.
6. The search matches a Session's title or branch, its Repo's name (`No Repo` for an anonymous Session) or checked-out
   branch, and a pull request number of the Session written as `#12`.
7. **+ New** opens one panel: a Repo picker (searchable, `No Repo` first, then A to Z) and, for a Repo, a searchable
   branch picker, where a name typed in makes a new branch from the default one, and Start. With a Repo picked in the filter it starts there. No Repo needs only Start.

### Pull requests

8. The list is flat and grouped by what the operator does next: Changes requested, Checks failing, To review
   (not yours, not approved), Waiting on review (yours), Ready to merge, Merged or closed. Within a group the host's
   order stays.
9. A row is two lines. First: the title and time since opened. Second: the number, project and author, then
   `agent` when a Session worked on the branch, a checks mark, the review state and the comment count. A repository
   not imported as a Repo, and a GitLab one, open on the host as before and say `not imported` or carry `↗`.
10. The search (a number asks the Git host), Mine/Others/All and Refresh share one line; the stale warning is unchanged.
    The groups already split by next step; a project picker on the next line narrows to one repository.

### Pull request page

11. The header holds the number and title. Under it sit the author's initials, branch → base, the state when not
    open, then the number, author, time since opened, additions and deletions and "Open on the host". The actions sit
    on the right: Agent Review, Approve, Merge, and a More actions menu with Request changes; Approve and More actions
    are not on the operator's own pull request. Agent Review opens a Session (see pr-actions-open-sessions). Request
    changes opens its box under the header. Merge stays disabled until a reviewer approved and asks
    before it merges.
12. Three tabs sit under the header, in the look of Accounts and Usage: Overview, Files changed and Commits, the last
    two with their counts. The tab is remembered in this browser. Overview shows the conflict box when there is one,
    the description ("No description." when empty) and Activity: the
    comment box, then the threads. Files changed shows the files with Expand all, Collapse all and the viewed count;
    a file that conflicts says `conflict` on its header. Commits lists the branch's commits newest first: message,
    author, age and the short hash, which opens the commit on the host.
13. A sidebar on the right stays in view while the page scrolls. Each section folds, and a fold holds on every pull
    request. The sections are Checks, then "N of 5 merge checks passed" (approval, checks, conflicts, open threads,
    agent review), then the people, then the threads with Address comments and Check replies, then the Sessions on the
    branch: the PR action Sessions with their state, the operator's own Sessions on the branch, and New Session. Check
    replies and Address comments open PR action Sessions.
14. A merged or closed pull request shows its state in the header and no actions.
15. For an open pull request the console checks whether the branch merges into its base as both stand on origin. It
    fetches the base and the head into the Repo's folder and runs `git merge-tree`, which touches no branch and no
    work tree. The check runs in the background, says "Checking for conflicts" until it lands, and is kept for two
    minutes at the same head commit. With conflicts, Overview shows a box naming each file. A file in the diff opens
    in Files changed. The box also gives the git commands to resolve them on the branch, and Merge stays disabled. When
    git cannot fetch, the check says "Conflicts not known".

## Not required

- **Per-Repo fold state**: Repo groups and project folds are gone, so nothing remembers them.
- **Starting a Session from an empty Repo's row**: + New is the one place.
- **Draft state, each CI build and the reviewers asked**: the Git host sync does not read them, so the page does not
  show them.
- **Full dates on a row**: a Session row shows the time since last active and a pull request row the time since opened; the full dates are in the tooltip.

## Safety

Approve, Request changes, Merge and the agent actions call the same endpoints with the same confirmations. Merge
keeps its confirmation step. The conflict check writes only remote-tracking refs (`origin/<base>`) and fetched objects
in the Repo's folder, the same fetch a Session on an origin branch already makes.

## UI

Loading, empty and error states are kept for both lists and the page. The empty list says "No Sessions yet. Start
one with + New." or "No Session in this view." for a filter with no match.

## Seams

- **Browser** (`frontend/e2e/workspace.spec.ts`): 1 to 7, hover card included, and `monitor-lists.spec.ts` for the times on rows. The pull request specs (`pr-thread-actions`,
  `session-links`, `shell`) cover 8 to 14; `pr-thread-actions` covers the tabs, Commits, the conflict box, More actions and the Merge confirmation.
- **Backend** (`backend/test/workspace.test.ts`): 15 against a real origin with one conflicting and one clean branch,
  and the commits the host lists.

## Out of scope

- A file tree beside the diff on Files changed (design P2).
