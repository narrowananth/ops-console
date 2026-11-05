# Playbook Skills

**Status:** draft
**Design:** Playbooks in `design/ops-console.html` (sidebar item under Claude, after Playbooks; the open Playbook in the
middle column). The Skills page, the Skills section of a Playbook and the Skills line on a job card are new to the
design.

## Problem

A Playbook gives the agent fixed rules and steps. When the work needs a method the Playbook does not spell out (how to
debug a failing route, how to review a diff against the team's standards, how to grill an assumption), the operator
pastes it into the rules of every Playbook, or retypes it in a Session. The rules grow past what every step needs, and
the agent reads all of it on every turn whether the step calls for it or not. The operator wants a place to keep such
methods once, attach them to the Playbooks that need them, and let the agent pick the right one while a step runs.

## Behavior

### Skills page

1. The sidebar lists Skills under Claude, after Playbooks. The page lists the operator's Skills A to Z, each with the
   number of Playbooks that hold it, and the open Skill beside the list. With none, it shows an empty state and
   "New Skill".
2. A Skill has a name, a description and instructions. The name is lowercase letters, digits and hyphens, at most 64
   characters, and unique among Skills ignoring case. The description says when the agent should use the Skill, at most
   1024 characters. The instructions are Markdown, at most 20000 characters. All three are required.
3. New Skill, edit and delete save like the Playbook editor: a save bar appears on unsaved edits, Discard puts the
   saved text back. A name already taken, or a field over its limit, refuses the save and says which field.
4. The open Skill lists the Playbooks that hold it, each a link to that Playbook. Deleting a Skill held by Playbooks
   asks first and names them. Delete takes the Skill off each of them; it does not delete a Playbook.
5. Renaming a Skill renames it in every Playbook that holds it. The Skill page warns not to put secrets, connection
   strings or customer data in a Skill: the agent can read its text.

### Attaching to a Playbook

6. The open Playbook shows a Skills section under Rules, with a count out of 8 and a picker of the Skills not yet held.
   Adding and removing are edits that save with the Playbook. A ninth Skill is refused.
7. Each held Skill shows its name and description, and links to its page. A Skill removed from a Playbook is not
   deleted.
8. A Playbook may hold Skills whichever Triggers it is on, including Review PR: a Skill is read-only text and writes
   nothing. Built-in Playbooks hold none and cannot be edited, so a Trigger that runs its built-in offers no Skills.
   Dev tools Sessions have no Playbook and no Skills.
9. Duplicating a Playbook copies its Skills.

### At run time

10. A job (Verification, Fix, Agent Review, Reply check, Comment pass) copies its Playbook's Skills when it starts,
    as it copies the rules. Editing or deleting a Skill, or taking it off the Playbook, does not change a job already
    running. A chat (Reply in thread, Session message) reads the Playbook's Skills at each message, so an edit applies
    from the next message.
11. The agent sees each held Skill's name and description on every turn, and loads a Skill's full instructions only when
    it judges a step needs it. The console does not paste Skill text into step prompts. A Skill the Playbook does not
    hold is not offered, and a Skill file in a Repo's own code does not load in a run that holds Skills.
12. Skills sit under the Playbook's rules: they add method and never relax a rule. The console's safety lines still
    come last and win. A Skill that says to merge, to push, to read a secret or to write to a PROD Connection changes
    nothing: PROD writes still ask for Approval in every Access mode.
13. A Playbook with no Skills runs as before.
14. When the agent loads a Skill, the Action Log shows it as an action of that run with the Skill's name. The job card
    shows the Skills the job was offered. Nothing in the console counts or scores Skill use.
15. A run whose Skills cannot be handed to it fails with the reason, the way a run fails when the Run sandbox is
    unavailable. It does not run without them.
16. Two Sessions that hold the same Skill each get their own copy. A stopped or finished run leaves nothing behind.

## Settled

- **Skill**: console-managed text, one instruction document, no scripts or attached files. Stored in SQLite, not read
  from `~/.claude/skills` or a Repo. Not the same thing as the vendored skills in `.agents/skills/`, which are for the
  developers of this repo.
- **Attach point**: the Playbook, not the step, not the Trigger. Every step of every job on that Playbook may use any of
  its Skills.
- **Choice at run time**: the agent's, through Claude Code's own skill listing. The console enables only the held
  Skills for the run and does not force one.
- **Hand-off**: the daemon writes the held Skills to a throwaway folder per run, readable by the Run sandbox, and loads
  it as a local plugin with the `skills` option listing them. It removes the folder when the run ends.
- **Limits**: 8 Skills per Playbook; 20000 characters of instructions.
- **Order**: lists sort A to Z by name, ignoring case.
- **Job copy**: a job stores the names of the Skills it was offered, with its Playbook name and rules. A Skill's text
  is not copied into the job.

## Not required

- **Skill text frozen for a running chat**: a chat reads the Playbook at each message, so a Skill edit applies on the
  next message.
- **Proof that the agent used the right Skill**: the console shows what was offered and what loaded, not whether the
  choice was good.
- **Per-turn cost accounting**: Skill descriptions add a few lines to every turn; the console does not meter it.

## Safety

The agent's reach is the same as before: Skills are text the operator wrote, read through the same prompt channel as
Playbook rules. They add no tool, Connection, command or file access, and the safety lines, the Run sandbox and the
Network allowlist still apply. The run folder holding the Skills is read-only to the run. A Skill is not a trusted
instruction source above the safety lines: see Behavior 12.

## Database

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX skills_name ON skills (name COLLATE NOCASE);

CREATE TABLE playbook_skills (
  playbook_id TEXT NOT NULL REFERENCES playbooks (id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  PRIMARY KEY (playbook_id, skill_id)
);

-- On each job table that already holds playbook_name and playbook_rules:
ALTER TABLE reports ADD COLUMN playbook_skills TEXT; -- JSON array of Skill names offered; null for none
ALTER TABLE fixes ADD COLUMN playbook_skills TEXT;
ALTER TABLE reviews ADD COLUMN playbook_skills TEXT;
```

Existing rows keep `playbook_skills` null and no Playbook holds a Skill.

## API

### Common

`Skill`:

```json
{ "id": "…", "name": "systematic-debugging", "description": "…", "instructions": "…", "playbooks": [{ "id": "…", "name": "…" }] }
```

| Status | Error code | When |
| ------ | ---------- | ---- |
| 400 | `invalid_input` | A field is empty, over its limit, or the name has other characters |
| 404 | `not_found` | No Skill with that id |
| 409 | `name_taken` | Another Skill has the name, ignoring case |

### `GET /api/skills`

`{ "data": { "items": Skill[] } }`, sorted A to Z.

### `POST /api/skills`

Body `{ "name", "description", "instructions" }`. Returns `{ "data": Skill }`.

### `PATCH /api/skills/:id`

Any of the three fields. Returns `{ "data": Skill }`.

### `DELETE /api/skills/:id`

204. Takes the Skill off every Playbook.

### `POST /api/playbooks`, `PATCH /api/playbooks/:id`

Add `skill_ids: string[]` (default `[]`, at most 8, no repeats). An unknown id is `404 not_found`; a ninth is
`400 invalid_input`. `Playbook` gains `skills: { id, name, description }[]`, sorted A to Z.

### WebSocket `skills.changed`

Server to client, `{}`. Fires after a Skill is created, edited or deleted. The UI reads Skills and Playbooks again.

## UI

- **Skills page**: sidebar item under Claude after Playbooks, route `/skills`. Two columns like Playbooks: list on the
  left, editor in the middle. States: loading, empty (New Skill), error with retry, unsaved edits (save bar). Departs
  from the design: new page.
- **Playbook editor**: Skills section under Rules with the picker and the count. With no Skills, the section reads
  "No Skills. The agent follows the rules and steps only."
- **Job cards** (Report panel, Fix, Agent Review, Comment pass): one line, "Skills offered: a, b", linking to each
  Skill. Hidden when none. A Skill since deleted shows its name as plain text.
- No PROD state: a Skill reaches no Connection.

## Rejected

- **Skills read from `~/.claude/skills`**: ties a run to one Mac's files and the Run sandbox does not read them.
- **Skill attached per step**: more UI and more state for a choice the agent already makes at run time.
- **Skill text pasted into every step prompt**: costs tokens on every turn and takes the choice from the agent.
- **Skill per Trigger**: the Playbook already holds the method for a Trigger; a second place would conflict with it.
- **Skills with scripts or reference files**: a script runs code the console cannot review; text only until that is
  needed.

## Glossary

- **Skill**: A named, console-kept instruction document the operator attaches to a Playbook. The agent sees its name and
  description in every turn of the job and loads the instructions when a step needs them. Text only.
  _Avoid_: plugin, add-on, prompt

Playbook: add "and the Skills it holds" to the definition.

## ADR

None. Reversible, and it follows ADR 0005: Claude Code's own skill loading is the integration point.

## Seams

- **Skills service** (backend + SQLite): 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 15.
- **Run options** (unit, over the Agent SDK fake): 11, 12, 14, 16. Asserts the options a run passes: the plugin folder,
  the `skills` list, the readable folder, and that a run with none changes nothing.
- **Skills page and Playbook editor** (frontend component): 1, 2, 3, 4, 6, 7.
- **Skill to job** (browser, Playwright): 6, 10, 14. Attach a Skill, start a job, see "Skills offered" on its card.

## Out of scope

- Import from `~/.claude/skills`, a URL or a Git repo: later, once the console-kept Skills prove useful.
- Skills with scripts or reference files.
- Per-step attach and Skill use reports across jobs.
- Skills on Dev tools Sessions.
