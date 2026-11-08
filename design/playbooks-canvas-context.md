# Playbooks canvas: design context

Read this before drawing. The mockup is page `#playbooks` in `design/ops-console-sidebar.html`; the behavior is
`docs/specs/playbooks-redesign.md`.

## Goal

Show which Playbook each Trigger runs, and edit a Playbook as a picture of the run: the Trigger, each step in order, the
console's closing turn, and the things that shape every turn (Rules, Skills, Settings), with the selected node's fields in
a side panel.

## Reference

UX Pilot's workflow editor: a palette of ready-made blocks on the left, a dotted canvas of cards joined by arrows, a
properties panel on the right for the selected card.

Take from it:

- Dotted canvas, cards with a phase tag, a title and a short body.
- Arrows between cards; the selected card gets an outline and its fields open in the right panel.
- Palette on the left; drag a block onto a line of the flow.
- Cards for what applies to the whole flow, tied to it by a thin dashed line.

Leave out:

- Decision gates, loops, optional paths and feedback arrows. A Playbook has none: steps run in order, one agent turn each,
  and a failed step stops the run.
- Durations, team assignment, deliverables, progress.
- The word "workflow". `GLOSSARY.md` lists it under Playbook's Avoid.

## Two views

**Overview.** Opens first. Triggers on the left, grouped under Monitor and Workspace, each naming the Playbook it runs
("Built-in", or the operator's Playbook). The selected Trigger's preview on the right: a run card with a dropdown (Built-in
and the operator's Playbooks), a small flow of the first five steps, and three facts. "Your Playbooks" lists the operator's
own, only when there is one. New Playbook sits in the page header here and nowhere else.

**Flow.** One Playbook as nodes on a dotted canvas, wrapping to a new row at the canvas width.

| Node | Domain term | Notes |
| --- | --- | --- |
| Trigger | Trigger | Click to attach or detach Triggers. A new Playbook runs on none. |
| Step card | Playbook step | Number, title, one-line instruction, "scratch copy" tag when it writes. Up to 12. |
| Console's turn | Closing turn | Dashed, not a step: cannot move or remove. Chat-only Playbooks show none and grey their steps. |
| Rules, Skills, Settings | Rules, Skills, Branch, Jira ticket | Three cards above the flow, joined by a dashed line marked "applies to every turn". |

The panel on the right opens on a click and closes with × or Escape. Its left edge is a bar to drag, or move with the arrow
keys; a double click resets it. Rules and Skills show a token estimate (characters divided by four); the Rules meter tints
above 1500 characters.

## Rules the canvas must keep

- Built-in Playbooks are read only: the flow is drawn, every field is read only, a banner says so, there is no palette
  and no action button. An editable copy comes only from New Playbook, Blank or Copy of a built-in.
- A Playbook attaches from a Trigger's dropdown on the overview, or from the Trigger node's chips. Choosing Built-in
  detaches it. Attaching over another Playbook asks "Replace?" first. Nothing is dragged onto a Trigger.
- A step dropped outside the canvas is removed; a block dropped on a line lands there. The added step opens in the panel.
- Keyboard path for every drag: + on a block, Alt and the arrow keys on a focused step, Delete, Remove in the panel.
- Save is off, with a plain line naming what is missing, while a step lacks a title or instructions.
- Unsaved edits survive leaving the page (Remembered view).

## Look

Tokens from `frontend/src/styles/theme.css` (copied into the sidebar file): Archivo, rounded controls, accent `#ec3013` only
for selection and the primary action, light and dark. Step cards use a neutral card; scratch-copy steps get the existing warn
tag instead of a new color. Color means state here, not category.

## Settled

- The canvas arranges and reads; text is edited in the panel. Order is all the daemon keeps, so there is no free placement.
- The Playbook list is the overview, not a rail or a switcher.
- Desktop only: no phone or narrow layout.
