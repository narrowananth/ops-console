# Agent Playbooks

**Status:** shipped
**Design:** Playbooks in `design/ops-console.html` (sidebar, under Claude after Agents & accounts), in three columns:
Triggers and Playbooks on the left, the open Playbook in the middle, Step blocks on the right. The same file shows
the Playbook on the Monitor Verify button and Report panel, the Session header and the Agent Review card.

## Problem

Each place the agent starts work has its method fixed by the console. A Verification always follows the same four
steps (map the log, replay, cross-check, decide), a Fix always runs Code then Tests, an Agent Review always reads
the diff the same way, and a Session or Dev tools question gets no standing instructions at all. The operator knows
how their services should be checked: which Repo really owns a failure, which other services call the feature,
which Connection holds the data that explains it, how to build mock data and test a lasting fix instead of a quick
patch. They have no place to write that down, so they retype it in every Session or the agent guesses.

## Behavior

### Triggers and Playbooks

1. The Playbooks page lists six Triggers under their tabs. Monitor: Verify and Fix. Workspace: Review PR, Reply in
   thread and Session message. Dev tools: Ask.
2. Each Trigger holds exactly one Playbook. A Trigger with none runs its built-in Playbook, which holds today's
   method: Verify has the four steps it follows now, Fix has the steps Code and Tests, Review PR has one step,
   Review, and the three chat Triggers have no rules.
3. Built-in Playbooks are read-only. Duplicate makes an editable copy named "Copy of Verify (built-in)".
4. The operator creates a Playbook from nothing or by Duplicate. A Playbook has a name, rules and ordered steps.
   Limits: name 60 characters and unique without regard to case, rules 8000, at most 12 steps, step title 80, step
   instructions 4000. A Playbook may have no steps.
5. One Playbook may hold several Triggers; editing it changes what each of them runs from their next job or turn.
   Attaching a Playbook to a Trigger that already holds one replaces it after a confirm: "Verify runs Checkout deep
   check. Replace it with Safe DB fix?"
6. Detaching a Playbook from a Trigger puts the built-in back. Deleting a Playbook detaches it from every Trigger
   first, after a confirm that names them: "Delete Safe DB fix? Fix and Session message go back to built-in."

### Building a Playbook

7. The Step blocks column holds ten blocks, each with written instructions: Trace the log through the code, Find
   the Repo that owns it, Find who else uses it, Read real data from Connections, Replay the request locally, Make
   mock data, Run the tests, Test a lasting fix, Check PROD readiness, and Custom step (empty).
8. Dragging a block into Steps inserts a copy at the drop point; the copy's title and instructions are then the
   Playbook's own to edit. Dragging a step reorders it. Dragging a step out of Steps removes it. Dragging a Playbook
   onto a Trigger attaches it (Behavior 5), and dragging a Trigger's chip off it detaches it.
9. Every drag move has a keyboard and button path: Add to steps on a block, Move up and Move down and Remove on a
   step, Attach to and Detach on a Playbook.
10. A step that writes files or runs commands carries the tag "scratch copy". The blocks Replay the request locally,
    Make mock data, Run the tests and Test a lasting fix carry it, whatever the step's text says; Custom step has a checkbox for it. Editing a step's text keeps its tag.
11. Review PR reads only. Attaching a Playbook that has a tagged step to it is refused: "Review PR reads only: remove
    Make mock data first." Adding a tagged step to a Playbook that Review PR holds is refused the same way on Save.
12. Save writes the Playbook; Discard drops the edits. Unsaved edits stay in the browser until Save or Discard,
    through page switches, reloads and reopening the console, and the Playbook's row shows a dot while they exist.

### Running a job

13. Verify, Fix and Review PR start jobs. A job copies its Trigger's Playbook (name, rules, steps) when it starts.
    Editing, detaching or deleting the Playbook later changes neither the running job nor its record; the Report,
    Fix and Agent Review show the name and steps they ran.
14. Each step is its own agent turn in the job's Session, in order. The turn carries the step's instructions and asks
    the agent to end with its outcome: done, skipped or failed, and a summary of at most 500 characters. The job view
    shows each step as pending, running, done, skipped or failed, with its summary, live.
15. A skipped step lets the job go on: a step about a database the agent cannot reach can be skipped. A failed step
    stops the job, which fails with "Step 3 · Make mock data failed:" and the summary. An agent error, an answer the
    console cannot read and the operator stopping the run each fail the running step.
16. After the last step the console runs its own closing turn: the Verification writes the Report, the Agent Review
    writes its findings, checklist and verdict, and the Fix goes on to its PR stage. Report, Agent Review and PR keep
    today's shape.
17. A failed Verification offers "Retry from step 3": it runs again from the failed step in the same Session, with
    the same copy, into the same Report version. Verify again starts a new Report version with the Playbook Verify
    holds now. A failed Fix retries from its failed stage or step. A failed Agent Review runs whole again when the
    operator asks for a review.
18. The buttons that start a job name a Playbook that is not built-in: "Verify with agent · Checkout deep check".
    With the built-in they read as today.

### Chat Triggers

19. Session message, Reply in thread and Ask are chats, so they use only a Playbook's rules. On the page their
    Playbook's steps show greyed with "Steps don't run on chat Triggers."
20. A chat Trigger reads its Playbook at each turn, so an edit applies from the next message.
21. In an Alert's Session, the operator's messages use the rules the Alert's latest job copied, not Session message.
22. A Session's and a Dev tools Session's header names the Playbook its rules come from, when it is not built-in,
    and links to it on the Playbooks page.

### Rules

23. Rules go into the system prompt of every turn the Trigger starts, after Claude Code's own and the console's
    instructions for that kind of run, and before the console's safety lines.

### Scratch copy for a Verification

24. A Verification runs in a scratch copy of the code: a git worktree of the Service's Repo, or of its clone, at the
    commit its default branch points to locally, kept in the data directory. The agent may write files there (mock
    data, a test) and run local commands. The operator's checkout keeps its branch and its uncommitted changes.
25. The scratch copy is removed when its Report is ready, or when the Alert's next Verification starts. A failed
    Report keeps it for Retry. At start-up the daemon removes every scratch copy whose Report is neither running
    nor failed.
26. A Fix runs in the Repo's checkout, as today, and starts a new agent conversation there. Its brief carries the
    Report, so nothing written in the scratch copy reaches the Fix branch.
27. If the scratch copy cannot be made (the default branch is missing locally, git fails), the Verification fails
    before step 1 with "Could not make a scratch copy:" and git's message.

### Safety and what must not regress

28. Nothing a Playbook says widens the agent's reach. Merging stays denied, a PROD write still asks, Access Levels
    and disabled MCP Servers still hold, and a Verification still writes to no Connection.
29. Every job and chat turn carries the mock data rule: mock data is made up, shaped like the real data, and no
    value read from a PROD Connection is written to a file, a commit, a PR or its comments, a Ticket or a Report.
30. With every Trigger on its built-in, Verification, Fix and Agent Review give the same output as before, and Fix
    progress shows Ticket, Branch, Code, Tests, PR.
31. Two jobs at once each run their own copy; editing or moving a Playbook while both run changes neither.
32. A daemon restart mid-step fails the step and its job as interrupted, as start-up recovery does today.
33. Reports and Agent Reviews made before this change show no Playbook. A Fix made before it shows its Code and Tests
    stages as the steps Code and Tests.

## Settled

- **Trigger, not Action**: the Action Log already means each query or command the agent runs, so the six places that
  start the agent are Triggers.
- **One Playbook per Trigger**: the agent is never told two methods at once, and a button always runs the same
  Playbook. No scope by Service or Repo and no pick at run time; rules for one Repo belong in its `CLAUDE.md`,
  which runs already load.
- **Many Triggers per Playbook**: one edit reaches each Trigger that holds it.
- **Built-in in code**: the six built-in Playbooks and the ten Step blocks ship with the console and are not rows,
  so an update can improve them. A Trigger with no row holds its built-in.
- **Job Triggers and chat Triggers**: Verify, Fix and Review PR start jobs with an end; only jobs run steps. The rest
  are chats and use rules only.
- **Steps are turns**: one turn per step, in the job's Session, so progress shows per step and Retry starts at the
  failed one.
- **Console keeps the contract**: a Playbook replaces the method. The closing turn's JSON, the safety lines and the
  Fix stages the console runs itself (Ticket, Branch, PR) stay out of the operator's reach.
- **Step outcome**: `done`, `skipped` or `failed`, plus a summary. `skipped` goes on, `failed` stops. Fix's old Tests
  check (`passed: false` fails) becomes the built-in Tests step answering `failed`.
- **Fix stages**: `ticket`, `branch`, `steps`, `pr`. The stage `steps` covers the Playbook's steps, in order.
- **Scratch copy tag**: a step's own flag, set by its block or the Custom step checkbox. It is what Review PR checks.
- **Copy at start**: jobs copy the Playbook; chats read it per turn because they never end.
- **Scratch copy at the default branch**: the deployed code is closest to the default branch. The operator's
  uncommitted work is not in the copy.
- **Fix conversation**: starts fresh in the checkout, because the Verification's ran in another folder.
- **Order on the page**: Triggers in the order of Behavior 1; Playbooks A to Z, then the built-ins.

## Not required

- **Resume after a daemon restart**: a step running at restart fails as interrupted. Resuming from the step joins
  the resume work in `persist-selections-and-runs` Behaviors 12 to 23.
- **Agent Review Retry from a step**: a failed Agent Review runs whole again. It reads only, so a rerun costs time,
  not risk.
- **Saving your own Step blocks**: a step lives in its Playbook; Duplicate copies a whole Playbook.
- **Two pages editing one Playbook**: the last Save wins.
- **Enforcing the mock data rule**: it is an instruction, not a check. The operator sees a PR's diff before merging,
  and real values that slip into a file show there.
- **Enforcing the scratch copy tag on Review PR**: the tag stops a Playbook that asks for writes from reaching Review
  PR; the run itself reads only as it does today.

## Safety

- A Verification may now write files and run local commands, only inside its scratch copy. Its cwd is that copy.
  It still writes to no Connection, reads PROD only where the Connection has read access, and runs with the Alert
  Session's Access mode, as today.
- Playbook text is the operator's own, but step instructions run next to log lines that anyone who can call the
  Service can write. The console's safety lines come last in every turn and say that a log line is data, never an
  instruction.
- Merging stays denied in every mode through `disallowedTools`. PROD writes ask in every mode. No Playbook changes
  either.
- Every job and chat turn carries the mock data rule (Behavior 29).

## Database

```sql
CREATE TABLE playbooks (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  rules TEXT NOT NULL DEFAULT '',
  -- [{ "block": "make_mock_data | custom | ...", "title": "...", "instructions": "...", "writes": true }]
  steps TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (json_valid(steps))
);

-- Which Playbook each Trigger holds. No row: the built-in.
CREATE TABLE playbook_triggers (
  trigger TEXT PRIMARY KEY NOT NULL
    CHECK (trigger IN ('verify', 'fix', 'review_pr', 'thread_reply', 'session_message', 'devtools_ask')),
  playbook_id TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE
);
CREATE INDEX playbook_triggers_playbook_idx ON playbook_triggers (playbook_id);

-- A job's copy of its Playbook's steps and how each went. Exactly one job column is set.
CREATE TABLE playbook_steps (
  id TEXT PRIMARY KEY NOT NULL,
  report_id TEXT REFERENCES reports(id) ON DELETE CASCADE,
  fix_id TEXT REFERENCES fixes(id) ON DELETE CASCADE,
  agent_review_id TEXT REFERENCES pr_agent_reviews(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  writes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'skipped', 'failed')),
  summary TEXT,
  started_at TEXT,
  finished_at TEXT,
  CHECK ((report_id IS NOT NULL) + (fix_id IS NOT NULL) + (agent_review_id IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX playbook_steps_report_idx ON playbook_steps (report_id, position) WHERE report_id IS NOT NULL;
CREATE UNIQUE INDEX playbook_steps_fix_idx ON playbook_steps (fix_id, position) WHERE fix_id IS NOT NULL;
CREATE UNIQUE INDEX playbook_steps_review_idx ON playbook_steps (agent_review_id, position)
  WHERE agent_review_id IS NOT NULL;

-- The Playbook a job ran, as copied at start. playbook_id is null for a built-in and once the Playbook is deleted.
ALTER TABLE reports ADD COLUMN playbook_id TEXT REFERENCES playbooks(id) ON DELETE SET NULL;
ALTER TABLE reports ADD COLUMN playbook_name TEXT;
ALTER TABLE reports ADD COLUMN playbook_rules TEXT;
-- The scratch copy's folder; null once removed.
ALTER TABLE reports ADD COLUMN scratch_path TEXT;
ALTER TABLE fixes ADD COLUMN playbook_id TEXT REFERENCES playbooks(id) ON DELETE SET NULL;
ALTER TABLE fixes ADD COLUMN playbook_name TEXT;
ALTER TABLE fixes ADD COLUMN playbook_rules TEXT;
ALTER TABLE pr_agent_reviews ADD COLUMN playbook_id TEXT REFERENCES playbooks(id) ON DELETE SET NULL;
ALTER TABLE pr_agent_reviews ADD COLUMN playbook_name TEXT;
ALTER TABLE pr_agent_reviews ADD COLUMN playbook_rules TEXT;
```

Migration:

- No Playbook rows: every Trigger starts on its built-in.
- Each existing Fix gets `playbook_steps` rows Code (position 0) and Tests (position 1), both with `writes` 1. A Fix
  at stage `ticket` or `branch` has both `pending`. At `code` or `tests`, the earlier one is `done` and its own row
  takes the Fix's status (`running` or `failed`). At `pr`, both are `done`. Then `fixes.stage` moves from `code` and
  `tests` to `steps`, and `playbook_name` becomes "Fix (built-in)".
- Reports and Agent Reviews get no rows and keep `playbook_name` null.

## API

### Common

`Step`:

```json
{ "block": "string", "title": "string, 1 to 80", "instructions": "string, 1 to 4000", "writes": true }
```

- `block`: the Step block it came from, `custom` for Custom step.
- `writes`: the scratch copy tag.

`Playbook`:

```json
{
  "id": "uuid | builtin:<trigger>",
  "builtin": false,
  "name": "string, 1 to 60",
  "rules": "string, up to 8000",
  "steps": [Step],
  "triggers": ["verify | fix | review_pr | thread_reply | session_message | devtools_ask"],
  "updated_at": "ISO 8601 | null"
}
```

- `steps`: at most 12.
- `triggers`: the Triggers holding it now. A built-in's lists its Trigger when no Playbook holds it.
- `updated_at`: null on a built-in.

`JobPlaybook`, added to `Report`, `Fix` and `PrAgentReview`, null on jobs from before this change:

```json
{
  "id": "uuid | null",
  "name": "string",
  "steps": [{ "title": "string", "writes": true, "status": "pending | running | done | skipped | failed", "summary": "string | null" }]
}
```

- `id`: null for a built-in and once the Playbook is deleted.

| Status | Error code          | When                                                                                     |
| ------ | ------------------- | ---------------------------------------------------------------------------------------- |
| 400    | `validation_failed` | A limit is broken, an unknown block or Trigger                                           |
| 404    | `not_found`         | No Playbook with that id                                                                  |
| 409    | `duplicate`         | Another Playbook has that name                                                           |
| 409    | `invalid_state`     | Changing or deleting a built-in, a Playbook with a `writes` step on `review_pr`, a retry of a job that has not failed |

### `GET /playbooks`

200 `{ "items": [Playbook], "blocks": [Step] }`. `items` in the page's order (Settled); `blocks` the ten Step
blocks in the order of Behavior 7.

### `POST /playbooks`

Body: `name`, `rules`, `steps`. 201 `Playbook`. Duplicate is this call with a copy's fields.

### `PATCH /playbooks/:id`

Body: any of `name`, `rules`, `steps`. 200 `Playbook`. `invalid_state` when Review PR holds it and a step `writes`.

### `DELETE /playbooks/:id`

204. Its Triggers go back to built-in.

### `PUT /playbook-triggers/:trigger`

Body: `{ "playbook_id": "uuid | null" }`. Null detaches. 200 `[Playbook]`, the list as in `GET /playbooks`.
`invalid_state` for a Playbook with a `writes` step on `review_pr`.

### `POST /alerts/:id/verifications`, `POST /alerts/:id/review`, `POST /repos/:repo/pull-requests/:number/agent-reviews`

Unchanged bodies. The Job they start copies the Trigger's Playbook; the `Report`, `Fix` and `PrAgentReview` they
return carry `playbook`.

### `POST /reports/:id/retry`

New. Runs a failed Report again from its failed step, in its scratch copy. 202 `Report` in `running`.
`invalid_state` unless the Report failed, is the Alert's newest, and kept its scratch copy.

### `POST /fixes/:id/retry`

Unchanged body. Retries from the failed stage, or the failed step when the stage is `steps`.

### WebSocket `playbook_step.updated`

Server to client, each time a job's step changes status.

```json
{
  "report_id": "uuid | null",
  "fix_id": "uuid | null",
  "agent_review_id": "uuid | null",
  "position": 0,
  "status": "pending | running | done | skipped | failed",
  "summary": "string | null"
}
```

`fix.advanced` keeps firing on stage changes, with the stage `steps` in place of `code` and `tests`.

## UI

- **Sidebar**: Playbooks under Claude, after Agents & accounts, at `/playbooks`.
- **Left column, Triggers**: grouped under Monitor, Workspace and Dev tools. Each is a drop target showing its
  Playbook as a chip, or a grey "Built-in" chip. A drag over it outlines it; a drag of a Playbook with a tagged step
  over Review PR shows it refused.
- **Left column, Playbooks**: the operator's Playbooks A to Z with the Triggers each holds, then the six built-ins
  marked "built-in". New Playbook sits in the page header. The open one is in the address as `?playbook=<id>`. Empty: "No Playbooks
  yet. Duplicate a built-in or start a new one." Loading: "Reading Playbooks…". Error: "Could not read Playbooks:"
  and the reason.
- **Middle column**: the name; "On: Monitor · Verify, Workspace · Session message" or "On no Trigger"; Rules as a text
  box with a count to 8000; Steps as numbered cards with a grip, title, instructions, the "scratch copy" tag, and
  Move up, Move down and Remove; a drop line where a dragged block or step would land; under the last step, "Then
  the console's own turn:" and what it is for each job Trigger. On a Playbook held only by chat Triggers the steps
  are greyed (Behavior 19). Save and Discard show while there are unsaved edits; Duplicate and Delete always. A
  built-in shows its text read-only with only Duplicate. A failed Save shows the error under Save and keeps the
  edits.
- **Right column, Step blocks**: the ten blocks, each with a grip, its title, the tag where it has one, and Add to
  steps. The instructions show on hover and on focus.
- **Monitor**: the Verify and Fix buttons name a Playbook that is not built-in (Behavior 18). The Report panel shows
  the Playbook's name, then its steps with status and summary above today's live tool steps, then "Writing the
  Report" during the closing turn. A failed one shows "Retry from step N" next to Verify again. Fix progress shows
  Ticket, Branch, each step by title, and PR.
- **Workspace, pull request**: Review with agent names a Playbook that is not built-in. An Agent Review shows its
  Playbook's name and steps above the findings.
- **Session and Dev tools Session headers**: "Playbook: <name>" linking to `/playbooks?playbook=<id>` (Behavior 22).
- **PROD**: no change. PROD Connections keep their badge and Approvals in every step.

## Rejected

- **Several Playbooks per Trigger, matched by Service or Repo**: the operator could not tell from the button which
  method would run, and two close matches could tell the agent different things.
- **A pick at run time**: the same button would run different methods on different days.
- **Playbooks that stack**: two Playbooks can contradict each other, and the job view could not name what the agent
  was told.
- **One prompt with numbered steps**: cheaper, but no progress per step and no retry part way.
- **Playbook files in each Repo** (`.ops-console/playbooks`): shared through git, but Monitor and Dev tools Triggers
  have no Repo. A team's rules for one Repo already reach every run through the Repo's `CLAUDE.md`.
- **Steps on chat Triggers**: the operator drives a chat message by message, so ordered steps have no start or end
  to run between.
- **Drag only**: a drag cannot be done from the keyboard; every move has a button too.
- **Verification writing in the operator's checkout**: mock files and test runs would mix with the operator's own
  uncommitted work.
- **Verification stays read-only, mocks only in the Fix**: the mock test is how a Verification proves the cause
  before the operator decides; after the Review it is too late to change that decision.
- **Copying real PROD rows into mocks**: customer data would land on disk and could ride into a PR.

## Glossary

- **Playbook**: the rules and ordered steps the agent follows when a Trigger starts it, written by the operator.
  Each Trigger holds one; one Playbook may be held by several.
  _Avoid_: rule, pipeline, workflow
- **Trigger**: a place in a tab that starts the agent: Verify and Fix in Monitor, Review PR, Reply in thread and
  Session message in Workspace, Ask in Dev tools.
  _Avoid_: action (the Action Log means each command the agent runs)
- **Playbook step**: one titled instruction in a Playbook, run as its own agent turn, ending done, skipped or
  failed.
- **Step block**: a ready-made Playbook step the operator drags into a Playbook and then edits.
- **Verification** (changed): the agent's attempt to explain an Alert from the code, in a scratch copy of it: follow
  the log through the code end to end, replay the request and test with mock data locally when it can, cross-check
  Connections, and write a Report on the issue and its fix.

## ADR

- **ADR 0002 rewritten: a Verification may write in a scratch copy.** Before this change the agent changed no code
  before the operator confirmed the Report. Now a Verification writes mock data and tests and runs them, only in a
  worktree in the data directory that is thrown away, never in the operator's checkout or a Connection. Trade-off:
  the operator gets a cause proven by a test before deciding, at the cost of letting a run steered by log text
  execute commands locally. The safety lines and the Alert Session's Access mode bound that. The old rule joins
  Considered Options. The operator approved it.

## Seams

- **Backend + SQLite** (services with the fake agent SDK and a temp git repo): 2, 3, 4, 5, 6, 10, 11, 13, 14, 15, 16,
  17, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33.
- **Browser** (Playwright against the dev daemon): 1, 7, 8, 9, 12, 18, 19, 22, and the page states in UI.

## Out of scope

- Resuming a step after a daemon restart: `persist-selections-and-runs` Behaviors 12 to 23.
- A Trigger for Scans and for the Setup agent.
- A model, effort or Access mode per step.
- Saving your own Step blocks, and sharing Playbooks between machines.
