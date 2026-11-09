import { EDITOR_PASTE_LIMIT, SKILL_LIMITS, type Skill } from '@ops-console/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spinner } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Hint } from '../components/ui/tip';
import { usePasteLimit } from '../lib/paste-limit';
import { useDeleteSkill, useSaveSkill } from '../lib/queries';
import { ascending } from '../lib/sort';
import { inWords } from '../playbooks/labels';
import type { Draft } from './drafts';

const small = 'px-2.5 py-1 text-xs';
const field =
  'w-full rounded-md border border-divider bg-card px-2.5 py-1.5 text-text outline-none focus:border-accent-400';

function Count({ used, limit }: { used: number; limit: number }) {
  return (
    <span
      title="Characters used, out of the most this field holds"
      className="ml-auto font-mono text-xs text-neutral-700"
    >
      {used} / {limit}
    </span>
  );
}

/** The open Skill: name, description, instructions, the Playbooks holding it, and Save while there are edits. */
export function SkillEditor(props: {
  skill: Skill;
  working: Draft;
  dirty: boolean;
  onChange: (next: Draft) => void;
  onDiscard: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const { skill, working, onChange } = props;
  const save = useSaveSkill();
  const remove = useDeleteSkill();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const descriptionPaste = usePasteLimit(EDITOR_PASTE_LIMIT, 'reject');
  const instructionsPaste = usePasteLimit(EDITOR_PASTE_LIMIT, 'reject');
  const holders = ascending(skill.playbooks, (playbook) => playbook.name).map((playbook) => playbook.name);

  return (
    <section aria-label="Skill" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full max-w-180 flex-col gap-5 px-7 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Name"
            value={working.name}
            maxLength={SKILL_LIMITS.name}
            onChange={(event) => onChange({ ...working, name: event.target.value })}
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 font-mono text-lg font-semibold text-text outline-none hover:border-divider focus:border-accent-400"
          />
          <Button
            className={`${small} text-accent-700`}
            title="Delete this Skill. It comes off every Playbook that holds it. Asks first."
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        </div>
        {confirmDelete && (
          <ConfirmDialog
            title={`Delete ${skill.name}?`}
            action="Delete"
            pending={remove.isPending}
            error={remove.error?.message}
            onConfirm={() => remove.mutate(skill.id, { onSuccess: props.onDeleted })}
            onCancel={() => {
              remove.reset();
              setConfirmDelete(false);
            }}
          >
            {holders.length > 0 &&
              `${inWords(holders)} ${holders.length === 1 ? 'holds' : 'hold'} it and will lose it. Jobs already running keep their copy. `}
            This can't be undone.
          </ConfirmDialog>
        )}
        <div className="-mt-3 px-1.5 text-xs text-neutral-700">
          Lowercase letters, digits and hyphens. Renaming it renames it in every Playbook that holds it.
        </div>

        <p role="note" className="m-0 rounded-lg border border-warn/50 px-3 py-2 text-xs text-neutral-700">
          Do not put secrets, connection strings or customer data in a Skill: the agent can read its text.
        </p>

        <section aria-label="Description">
          <div className="mb-1.5 flex items-baseline gap-2">
            <h2 className="m-0 text-sm">Description</h2>
            <Hint text="The agent reads this on every turn and decides from it whether a step needs the Skill. Say when to use it." />
            <span className="text-xs text-neutral-700">When the agent should use this Skill</span>
            <Count used={working.description.length} limit={SKILL_LIMITS.description} />
          </div>
          <textarea
            aria-label="Description"
            value={working.description}
            maxLength={SKILL_LIMITS.description}
            onPaste={descriptionPaste.onPaste}
            onChange={(event) => {
              descriptionPaste.clear();
              onChange({ ...working, description: event.target.value });
            }}
            className={`${field} field-sizing-content max-h-[30vh] min-h-16 resize-y overflow-y-auto text-[13px] leading-relaxed`}
          />
          {descriptionPaste.over && (
            <p role="alert" className="m-0 mt-1 text-xs text-accent-700">
              The limit is {EDITOR_PASTE_LIMIT.toLocaleString()} characters at once. The paste was not added.
            </p>
          )}
        </section>

        <section aria-label="Instructions">
          <div className="mb-1.5 flex items-baseline gap-2">
            <h2 className="m-0 text-sm">Instructions</h2>
            <Hint text="Markdown. The agent loads this only when it judges a step needs the Skill." />
            <span className="text-xs text-neutral-700">The method itself, in Markdown</span>
            <Count used={working.instructions.length} limit={SKILL_LIMITS.instructions} />
          </div>
          <textarea
            aria-label="Instructions"
            value={working.instructions}
            maxLength={SKILL_LIMITS.instructions}
            onPaste={instructionsPaste.onPaste}
            onChange={(event) => {
              instructionsPaste.clear();
              onChange({ ...working, instructions: event.target.value });
            }}
            className={`${field} field-sizing-content max-h-[50vh] min-h-48 resize-y overflow-y-auto font-mono text-xs leading-relaxed`}
          />
          {instructionsPaste.over && (
            <p role="alert" className="m-0 mt-1 text-xs text-accent-700">
              The limit is {EDITOR_PASTE_LIMIT.toLocaleString()} characters at once. The paste was not added.
            </p>
          )}
        </section>

        <section aria-label="Used by">
          <h2 className="m-0 mb-1.5 text-sm">Used by</h2>
          {skill.playbooks.length === 0 ? (
            <p className="m-0 text-xs text-neutral-700">No Playbook holds this Skill. Attach it in a Playbook.</p>
          ) : (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {ascending(skill.playbooks, (playbook) => playbook.name).map((playbook) => (
                <li key={playbook.id}>
                  <Link
                    to={`/playbooks?playbook=${encodeURIComponent(playbook.id)}`}
                    title="Open this Playbook"
                    className="rounded-full border border-line bg-card px-2.5 py-0.5 text-xs whitespace-nowrap text-text no-underline hover:border-accent-300 hover:bg-accent-100 hover:text-accent-900"
                  >
                    {playbook.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {props.dirty && (
        <div className="sticky bottom-0 mt-auto flex flex-col gap-1 border-t border-line bg-card px-7 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-700">Unsaved edits</span>
            <span className="flex-1" />
            <Button
              className={small}
              title="Throw the edits away and go back to the saved Skill"
              disabled={save.isPending}
              onClick={() => {
                save.reset();
                props.onDiscard();
              }}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              className={small}
              disabled={save.isPending}
              onClick={() => save.mutate({ id: skill.id, patch: working }, { onSuccess: props.onSaved })}
            >
              {save.isPending && <Spinner />}
              Save
            </Button>
          </div>
          {save.error && (
            <p role="alert" className="m-0 text-right text-xs text-accent-700">
              {save.error.message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
