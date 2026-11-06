# Agent runs page

**Status:** shipped
**Design:** agreed in chat as a mockup, light mode; no file in `design/`. The page uses the console's own colors and
adds an info blue for "needs you".

## Problem

The Running tray lists runs and nothing about how they go. The operator cannot tell a run that works from one stuck on
a command, cannot see where a run's time went, and gets only raw error text when a run ends. A queued message lives in
one browser tab, so no other view can show it.

## Behavior

1. A sidebar page, Agent runs, under Claude, at `/agent-runs`. Its badge counts runs that need the operator. The
   Running tray stays as the quick view and links to the page (behavior 15).
2. The top shows a ring and four counts: on track, slow, needs you, failed. Under them, today's runs ended, tokens and
   estimated cost, and a card for slow runs and one for failed runs, each with the button that deals with it.
3. Each run is a card, ordered needs you, slow, failed, on track, stopped. It shows title, Repo and branch, subagents,
   one line on why the run has its health, a strip of where its time went, the time elapsed, and Pause, Stop, Play,
   Retry or Dismiss. The title opens the Session, or the pull request for a review. Tabs filter by health or ended.
   A pull request review takes no messages, so it cannot pause or queue, but Retry runs again the job that failed last
   on that pull request, from its failed step. Retry all on the failed card does this for every failed run that can,
   and says how many started and why one did not.
4. Health is read by the daemon from what it saw. **Needs you**: an Approval or a question waits. **Slow**: a step has
   gone past three times the middle time of that command's earlier runs (at least two minutes), or past five minutes
   for a command seen fewer than three times; time spent waiting on the operator does not count. **Failed** and
   **stopped** follow the run's outcome. Anything else is **on track**.
5. A card opens to the run's detail, kept in the address (`?run=<session id>`). It shows the stage the run is at, why it
   is slow or ended, where the time went, a timeline with a lane per agent, every step, and the queued message.
6. The stages come from the run, not a fixed list. A pull request review goes Read PR, Explore, Analyze, Write comments,
   Post review. A run that edits, tests, commits or opens a pull request goes Read task, Explore, Edit, Run tests, Fix,
   Commit + hooks, Open PR. A run that only reads, searches and uses subagents goes Read task, Explore, Analyze, Report.
   A stage is done only with evidence: an edit for Edit, a test command for Run tests, a commit for Commit, and so on.
   A stage the run went past with none shows as skipped, and the stage of the newest call shows as now. A run that
   ended early marks the stage it stopped in with why: usage limit, failed or stopped.
7. **Why this run is slow** gives the step and how long it has run against its usual time, a likely cause, and a
   suggestion. The cause comes from the command: one that reaches the network or runs tests names the Run sandbox's
   allowlist as a possible cause; any other says the console cannot see what the step waits on. The console does not
   guess what the agent thinks. Buttons: Stop the run, Stop and tell the agent to skip it, Allow the host the command
   names, and a link to the Network allowlist.
8. **Why this run ended** gives what happened, the likely cause and what to do, with the raw error under them. Kinds:
   network blocked, write blocked, usage limit, signed out, commit hook failed, console restarted, unknown. Unknown
   says the console has no more than the error. A commit hook failure tells the operator to fix what the hook reports;
   it never offers to skip the hook. A blocked host offers Allow and Retry, which adds the host to the Network
   allowlist and then retries.
9. The time split gives every millisecond of the main agent's run to one phase: thinking (the gaps between calls),
   reading, editing, commands and tools, subagents (the main agent is blocked on a subagent call), waiting on the
   operator, and waiting on the usage limit. The total equals the elapsed time in the run's header, read from one clock.
   Percentages add up to 100 by largest remainder. A phase of 0s draws no segment; under one second reads "<1s". The
   headline names the largest phase, one command over half the run, or "62% waiting on 12 subagents". A table lists each
   subagent by duration with its own split, tokens and cost; a row filters the steps. The timeline draws thinking on
   every lane, folds a stretch with no call in any lane over a fifth of the width into a marker the operator can open,
   and zooms to Fit, 1m, 5m or a dragged range. Time accounting lives in `shared/src/run-time.ts`.
10. Every tool call of a run is kept with its time, outcome and error for 90 days. A run that ended before this
    shipped has none, and its detail says so.
11. A run's tokens are kept as raw counts per agent and model (input, output, cache read, cache write), each message
    once. The cost is those counts times one price table (`backend/src/agent/pricing.ts`); the SDK's own figure is kept
    beside it to compare. The run's total is the main agent plus every subagent. The day's total uses the same path. A
    subscription is not billed by the token, so the figure is an estimate. A run kept before raw counts shows the SDK's
    figure.
12. Stop all stops every run going, after the operator confirms. Play all carries on every paused or stopped run that
    can. Dismiss ended takes every ended run off the page.
13. The queued message is kept by the daemon, one per Session. It goes out when the run ends unless the operator stopped
    or paused the run, which holds it as "On hold". Send now sends it at once and stops a run that is going first. Take
    back clears it. Queue with no run going sends the message. A Session whose run is paused or stopped shows Play
    beside Send in its chat; Play carries the run on from the conversation, as it does on the page.
14. Desktop alerts, off until the operator turns each on: when a run needs them, and when a run ends. The Alerts pill
    in the page header and in the tray turns both on or off; the page keeps a switch for each. The browser asks
    permission once. An alert shows only while the console is open in a tab that is not in front, and not for what was
    there when the page loaded.
15. The Running tray shows the same runs in a popup. Its header gives the counts, the Alerts pill and Stop all going
    (which asks first). Chips filter All, Going, Needs you and Ended, with today's tokens and cost beside them. Runs
    sit in three groups: needs you, going (the first three, then Show all, which becomes Show less) and ended, which
    stay until dismissed. The popup is never taller than the room above the Running button, so its header stays in
    view. A row opens in place to its facts (kind, start or end, access, model, account, usage), links to the
    Session, pull request and Alert, the queued message with Send now and Take back, the same stage, why it is slow
    or ended, time split, timeline and steps as the page (5 to 9), and its subagents with a link to each. The footer links to the page and has Dismiss all ended.

## Not required

- **Pause the running command**: the SDK cannot stop one command and keep the run. Stop ends the run.
- **Why the agent is slow to think**: the console cannot see it, so thinking is shown as time only.
- **More than one queued message** per Session.
- **Alerts with the tab closed**: they need the console open.

## Safety

The page changes no file and runs no command itself. Stop, Pause and Dismiss end or hide a run. Play, Retry and Send
now send a message in the Session, under its access mode, Approvals and Run sandbox. Allow adds a host to the Network
allowlist, which the operator already controls on Permissions (`run-network-allowlist`); the button is one click, and
names the host on its face. Raw errors and step summaries are redacted before they are kept.

## UI

Loading, empty and error states follow the other pages. A control's error shows under its card.

## Seams

- **Daemon** (`backend/test/run-insight.test.ts`, `backend/test/agent-sessions.test.ts`): 4 to 11, 13 and 12.
- **Browser** (`frontend/e2e/agent-runs.spec.ts`, `session-links.spec.ts`, `workspace.spec.ts`): 1 to 3, 5, 7, 8, 12 and 13.

## Out of scope

- Reading the agent's own plan to place a run in a stage.
