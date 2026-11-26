# Servers the agent starts do not open a page by themselves

**Status:** shipped
**Design:** none. The Browser panel of a Session ([session-browser](session-browser.md)).

## Problem

A Session's Browser panel opened a tab for every server a Session process started. A test run the agent starts through
`start_process` starts a throwaway server on a port of its own, so each run left a tab behind: the console's own sign-in
page ("Run `ops-console open` to sign in") while the run lasted, then "Nothing is listening on :port". The operator closed
them by hand after every run.

## Behavior

1. A process the operator started opens its page in the Browser panel when it begins listening, as before
   ([session-browser](session-browser.md) 11a).
2. A process the agent started opens no page by itself. The agent opens the page it wants the operator to see with its
   browser tool, which names the address it opens.
3. The agent's servers still show in the Local servers list and the Session panel, and a click on a row opens one.
4. What must not regress: a process a reload finds already listening opens nothing, each port opens once, and a tab
   already on the site reloads instead of a new one opening.

## Settled

- **Who decides**: who started the process (`started_by`), which the daemon already records, not what the process runs.
- **A process missing from the list** when its server shows counts as the operator's, so a page for a process the operator
  just started is not lost to a read that arrives out of order.

## Not required

- **Telling a test run from a dev server** by its command or its port. The rule is about who started it.

## Safety

No change.

## Seams

- **Which servers open a page** (frontend unit, run with the browser specs): 1, 2, 4.
- **Regression**: 3 and 4 by `session-browser.spec.ts`.

## Out of scope

- Closing a tab when its server stops, and a sign-in for an Ops Console UI the agent opens.
