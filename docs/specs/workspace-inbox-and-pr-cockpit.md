# Workspace inbox and pull request cockpit

**Status:** built, not shipped
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
2. A row is two lines. First: state dot, title, one word for what the Session waits on (`approval`, `question`,
   `failed`) and time since last active. Second: a Repo chip (`No Repo` for an anonymous Session) and the branch.
   Stop shows on a busy row on hover or focus.
3. Repos with no Session do not show. Idle lists the first 8 Sessions with "Show N more"; a search, or the open
   Session, lifts the limit.
4. Chips filter by state (All, Needs you, Running, with counts) and a Repo picker narrows to one Repo or to No Repo.
   Chips and the picker are remembered in this browser.
5. The search matches a Session's title or branch and its Repo's name or checked-out branch.
6. **+ New** opens one panel: a Repo picker (searchable, A to Z, `No Repo` first) and, for a Repo, a branch picker
   and Start. With a Repo picked in the filter it starts there. No Repo needs only Start.

### Pull requests

7. The list is flat and grouped by what the operator does next: Changes requested, Checks failing, To review
   (not yours, not approved), Waiting on review (yours), Ready to merge, Merged or closed. Within a group the host's
   order stays.
8. A row shows the number and title, time since opened, a project chip, author, checks, review state, comment count
   and `agent` when a Session worked on the branch. A repository not imported as a Repo, and a GitLab one, open on
   the host as before and say `not imported` or carry `↗`.
9. Mine/All, Refresh, the search (a number asks the Git host) and the stale warning are unchanged. Chips filter
   All, To review and Failing, and a project picker narrows to one repository.

### Pull request page

10. The header holds the title, then one line: branch → base, author, additions and deletions, comment counts and
    "Open on the host".
11. The centre scrolls through the Agent Review card, the Comment pass card, the description, Files and Comments, each
    as before.
12. A right rail stays in view while the centre scrolls. It holds Merge readiness (approval, checks, open threads,
    agent review), then the actions: Agent Review, Approve, Request changes with its box, Check replies, Address
    comments, and Merge with its confirmation. Merge stays disabled until a reviewer approved. Below that: the
    Sessions on the branch with New Session, and the people.
13. A merged or closed pull request shows its state in the header and no actions.

## Not required

- **Per-Repo fold state**: Repo groups and project folds are gone, so nothing remembers them.
- **Starting a Session from an empty Repo's row**: + New is the one place.
- **Full dates on a row**: a Session row shows the time since last active and a pull request row the time since opened; the full dates are in the tooltip.

## Safety

No change. Approve, Request changes, Merge and the agent actions call the same endpoints with the same
confirmations. Merge keeps its confirmation step.

## UI

Loading, empty and error states are kept for both lists and the page. The empty list says "No Sessions yet. Start
one with + New." or "No Session in this view." for a filter with no match.

## Seams

- **Browser** (`frontend/e2e/workspace.spec.ts`): 1 to 6, and `monitor-lists.spec.ts` for the times on rows. The pull request specs (`pr-thread-actions`,
  `session-links`, `shell`) run against 7 to 13 unchanged.

## Out of scope

- A Files tab with a file tree beside the diff (design P2).
