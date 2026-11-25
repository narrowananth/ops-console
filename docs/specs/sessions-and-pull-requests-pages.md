# Sessions and Pull requests as two pages

**Status:** shipped
**Design:** `design/workspace-pr-bitbucket.html`, frame 1.

## Problem

Workspace holds Sessions and Pull requests behind a two-way switch at the top of its list pane. The operator switches back and forth, and the sidebar shows one item for both. A Session that needs them is badged only in the folded strip.

## Behavior

1. The app sidebar's Operate group lists Sessions and Pull requests where Workspace was. The Workspace item is gone.
2. Sessions opens the Sessions inbox on the left and the Session on the right. Pull requests opens the pull request list on the left and the pull request page on the right. The two-way switch above the list is gone.
3. The Sessions item shows the count of Sessions that need the operator, as a badge, when it is above zero.
4. An old link `/workspace`, with or without `tab`, `session` and `pr`, opens the right page with the same Session or pull request. `/workspace?tab=pulls&pr=…` opens Pull requests; any other `/workspace` opens Sessions.
5. A link to a Session or a pull request from anywhere in the console (Monitor, a Session's pull request chip, the hover card) opens the matching page.
6. Each list pane folds to a strip as today, and the choice is remembered per page.
7. The search, filters, groups and folds of each list work as before and are remembered as before.

## Settled

- **Addresses**: `/sessions` and `/pull-requests`, each with its own `?session=` or `?pr=`.
- **Old keys**: the remembered pane fold under `workspace.pane-collapsed` is read once as the value of both new pages.

## Not required

- **A shared fold**: each page remembers its own.

## Safety

No change.

## UI

Sidebar, both list panes, the empty states: "Pick a Session, or start one on a branch." and "Pick a pull request."

## Glossary

- **Workspace**: removed as a page name. The Sessions page and the Pull requests page keep the terms Sessions inbox and pull request page. Update every entry that says "in Workspace".

## Seams

- **Browser** (`frontend/e2e/workspace.spec.ts`, `shell.spec.ts`): 1 to 5 and 7.
- **Frontend component**: 6.

## Out of scope

- Moving the Session panel or the pull request page.
