# Playbooks Redesign

**Status:** shipped
**Design:** Playbooks, page `#playbooks` in `design/ops-console-sidebar.html`. It replaces the three-column Playbooks
screen of `design/ops-console.html`.

## Problem

The Playbooks screen shows Triggers, Playbooks, the open Playbook and the Step blocks at once. The operator cannot tell
which Playbook a Trigger runs, a new install gives no sign that every Trigger already runs a built-in, and editing means
reading a long form with steps as text cards. Nothing says what the Rules and Skills cost: both go to the agent on every
turn, and the operator has no way to see a Playbook growing heavy.

Behavior this spec does not list is as in `agent-playbooks` and `playbook-skills`; the list below names each departure.

## Behavior

### Overview

1. The page opens on an overview: a list of the seven Triggers on the left, grouped under Monitor (Verify, Fix) and
   Workspace (Review PR, Check reply, Address comments, Reply in thread, Session message), and the selected Trigger's
   preview on the right. Verify is selected first. The address `?trigger=<id>` selects another Trigger.
2. Each Trigger row names the Playbook it runs: "Built-in", or the Playbook's name tinted as the operator's own. A
   Trigger running a Playbook with unsaved edits shows the same dot as that Playbook's row (Behavior 5).
3. With no Playbooks yet, which is every new install, every Trigger reads "Built-in", the "Your Playbooks" list is
   absent, and the page has no empty screen. Nothing needs setting up for a Trigger to run.
4. The preview of a Trigger shows its name, one line on what the agent does there, JOB or CHAT, a run card, the flow
   the Trigger runs as small nodes (the first five steps, then "+N more") with a button that opens the full flow, "View
   full flow" or, on the operator's own, "Edit flow", and three facts: Rules, Skills, and Branch with Jira ticket. A
   built-in adds a note that it is read only and that a copy comes from New Playbook.
5. Under the Triggers, "Your Playbooks" lists the operator's Playbooks A to Z, shown only when there is one. Each row
   names the Triggers it runs on, or "on no Trigger", and carries an "unsaved" pill while the browser holds edits for
   it. A click opens that Playbook.
6. The run card names the Playbook the Trigger runs and its step count, tagged "Built-in · read only" or "Yours", with
   Edit on the operator's own. Its dropdown lists Built-in and the operator's Playbooks A to Z. Choosing a Playbook on a
   Trigger that holds another Playbook asks "Replace?" first, with Cancel focused. Choosing a Playbook on a Trigger that
   runs its built-in attaches it at once. Choosing Built-in detaches the Playbook at once and the built-in returns.
   Escape closes the dropdown.
7. A change on a Trigger applies from the next job or turn. A Playbook cannot be dragged onto a Trigger, nor a Trigger off
   one: the dropdown is the only way (departs from Agent Playbooks 8).
8. Deleting a Playbook asks first and names the Triggers that go back to built-in.
9. While the Playbooks load, the page reads "Reading Playbooks…". A failed read shows "Could not read Playbooks:" with
   the reason and a Retry.

### New Playbook

10. New Playbook sits in the page header. Its dialog asks for a name and a start: Blank, or Copy of a built-in, with a
    dropdown of the seven built-ins. The name is up to 60 characters and unique without regard to case.
11. A new Playbook runs on no Trigger. It opens on its flow with the Trigger node asking the operator to attach
    Triggers. A copy of a built-in starts with that built-in's rules and steps and holds no Skills.
12. A built-in has no Customize or Duplicate action. New Playbook, Copy of a built-in, is the only way to get an
    editable copy, and an operator's own Playbook cannot be copied (departs from Agent Playbooks 3 and 4, and Playbook
    Skills 9).

### The flow

13. A Playbook opens as a flow on a dotted canvas: the Trigger node, each step in order as a card, and the console's
    own turn as a dashed last node. The line of nodes wraps to a new row at the canvas width. Above the flow, three
    cards hold Rules, Skills and Settings, joined by a dashed line marked "applies to every turn". Up to 12 steps. A legend under the canvas names
    the two lines and says a failed step stops the run.
14. The console's own turn is not a step: it cannot be moved or removed. It reads, for each Trigger, what the console
    does after the steps. A Playbook that runs only on chat Triggers shows no closing turn, and its steps stay shown but
    greyed with the note that they do not run there.
15. A built-in opens read only: the same flow, every field read only, a banner "Built-in, read only", and no palette. The
    header holds no action button. The banner names the Playbook that replaced it on its Trigger, when one has. Its Skills
    card reads "A built-in holds none."
16. Selecting a node opens its fields in the panel on the right; the close button or Escape closes it. The panel shows
    the Trigger node's Trigger chips, a step's title, instructions and scratch copy tag, the Rules text, the Skills the
    Playbook holds with a picker of those it does not, or the Settings: Branch and the Jira ticket switch.
17. The palette on the left lists the ten Step blocks. Dragging a block onto a line of the flow inserts a copy at that
    point, and pressing its + appends one. A step dragged to another place moves, and a step dropped outside the canvas
    is removed. A step can also be removed with the Remove button in its panel.
18. Reordering and removing have a keyboard path: a focused step moves one place with Alt and the left or right arrow,
    and Delete removes it. A hint under the palette says so. The panel keeps no Earlier and Later buttons.
19. Attaching Triggers to a Playbook works from the Trigger node's chips. A Trigger held by another Playbook asks
    Replace first. No Trigger refuses a Playbook for holding a scratch copy step.
20. Save, Discard and the unsaved-edits label show while the browser holds edits for the open Playbook. A failed Save
    shows the error beside Save and keeps the edits. Unsaved edits stay in the browser through reloads and reopening the
    console until Save or Discard. Delete sits in the same bar on the operator's own Playbook.
21. The address `?playbook=<id>` opens that Playbook's flow, and `?trigger=<id>&view=flow` opens the flow of a Trigger's
    built-in. The Playbook link in a Session header still lands on the Playbook.

### Token meter

22. The Rules panel shows "≈ N tokens, sent on every turn of every run", counted as the text's length divided by four,
    rounded up. It updates as the operator types. It counts the operator's text only, not the console's own
    instructions. Up to 1500 characters it adds "Keep only what is always true; put methods in a Skill."
23. Above 1500 characters of Rules the meter is tinted and adds "Long. Move how-to text into a Skill." A built-in's
    Rules show the figure without the tint or the warning.
24. With at least one Skill held, the Skills panel shows "≈ N tokens per turn: names and descriptions only. A Skill's
    full text costs tokens only when a step loads it", counted the same way over each held Skill's name and description.
    A built-in's Skills panel shows only that it holds none.

### Controls

25. Buttons, dropdowns and switches use the console's shared sizes: the page's standard button, the compact button in
    toolbars and panels, the 30 pixel icon button, the shared dropdown field and the shared switch.

## Settled

- **Built-in everywhere**: the screen says "Built-in", never "Default".
- **Built-in Playbook**: the console's own Playbook for a Trigger. Read only. The console updates its text.
- **Copy**: only through New Playbook, and only of a built-in.
- **Token estimate**: made in the browser from character counts. No new API, no tokenizer.
- **Trigger blurbs and the console's own turn text**: fixed copy in the frontend, checked against what the daemon does.
- **Desktop only**: no phone layout, as on the other pages.
- **Scratch copy on Triggers**: no Trigger refuses it, as in `agent-playbooks` Behavior 11 and `pr-thread-actions`.

## Not required

- **Drag a Playbook onto a Trigger**: the dropdown is the one path.
- **Copy of the operator's own Playbook**: the operator makes a new one from a built-in.
- **Exact token counts**: the figure is an estimate and says so with "≈".
- **Counting the console's own instructions in the meter**: the meter covers what the operator wrote.

## Safety

No change. The Playbook, Rules, Skills and the agent's reach are as shipped. The meter reads text only.

## UI

Follows the Playbooks page of `design/ops-console-sidebar.html`. It departs from `design/ops-console.html`, whose Playbooks
screen has three columns.

- **Overview**: loading, error with Retry, first install (no "Your Playbooks"), and one or more Playbooks. Trigger rows
  carry the draft dot.
- **Flow, built-in**: read only, banner, no palette, no action button.
- **Flow, own Playbook**: editable, palette, panel, save bar. Empty flow shows an "Add the first step" node.
- **Panels**: Trigger, Step, Rules with meter, Skills with meter, Settings.
- **Dialogs**: New Playbook, Replace, Delete. Escape, Cancel or a click on the dimmed page closes each, with Cancel
  focused first.
- **PROD**: no change.

## Rejected

- **Customize a copy on a built-in**: New Playbook with Copy of a built-in already makes the copy; a second path
  attached it to the Trigger without the operator choosing a name.
- **Duplicate on the operator's own Playbook**: it made "Copy of" names the operator then renamed, and copies of copies.
- **Earlier and Later buttons in the step panel**: dragging and the Alt arrow keys cover reorder.
- **Drag a Playbook onto a Trigger**: two ways to attach, and the dropdown reads better on the overview.
- **A token counter in the daemon**: a second tokenizer to keep right for a figure the operator only needs roughly.
- **A refusal of scratch copy steps on read-only Triggers**: no shipped spec asks for it, and Review PR and Check reply
  may hold them.

## Glossary

- **Built-in Playbook**: The console's own Playbook for a Trigger, read only, which the console updates. A Trigger runs
  its built-in until the operator attaches a Playbook of their own. The operator copies one through New Playbook.
  _Avoid_: default Playbook

## Seams

- **Browser** (Playwright, against the dev daemon, `frontend/e2e/playbooks.spec.ts`): 1 to 25. The token figure,
  the 1500 character tint and the Skills meter (22 to 24) assert on typed text. The first install (3) runs against a
  daemon with no Playbooks.

## Out of scope

- The backend token savings: send the commit and pull request rules only to runs that write, move the step boilerplate
  into the system prompt once, and a model per step. Each is its own `/spec`.
- A phone or narrow layout.
- Skills on a built-in Playbook.
