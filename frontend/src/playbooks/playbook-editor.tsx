import { PLAYBOOK_LIMITS, type Playbook, type PlaybookTrigger, StepBlock, TRIGGER_LABELS } from '@ops-console/shared';
import { useState } from 'react';
import { Button, Spinner } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { ResizeHandle, usePanelWidth } from '../components/ui/resize-handle';
import { useDeletePlaybook, useSavePlaybook, useSkills } from '../lib/queries';
import { ascending } from '../lib/sort';
import type { Draft, DraftStep } from './drafts';
import type { Drag } from './drag';
import { FlowCanvas, type Sel } from './flow-canvas';
import { Inspector } from './inspector';
import { holderOf, inWords, triggerOfBuiltin } from './labels';
import { Lock } from './lock';
import { Palette } from './palette';

/** The panel's size: its width until the operator drags it, its narrowest, and the room the palette and canvas keep. */
const PANEL = { key: 'playbooks.panel-width', initial: 336, narrowest: 280, keep: 520 };

/** One Playbook as a flow: toolbar, the Step blocks, the canvas and the panel of the picked node. */
export function PlaybookEditor(props: {
  playbook: Playbook;
  items: Playbook[];
  blocks: DraftStep[];
  working: Draft;
  dirty: boolean;
  onChange: (next: Draft) => void;
  onDiscard: () => void;
  onSaved: () => void;
  onBack: () => void;
  onDeleted: () => void;
  onToggleTrigger: (trigger: PlaybookTrigger) => void;
}) {
  const { playbook, working, onChange } = props;
  const readOnly = playbook.builtin;
  const save = useSavePlaybook();
  const remove = useDeletePlaybook();
  const skills = useSkills();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A Playbook made just now has no Trigger and no step: open on the Trigger node, where the operator attaches it.
  const [sel, setSel] = useState<Sel | null>(
    !readOnly && playbook.triggers.length === 0 && playbook.steps.length === 0 ? { kind: 'trigger' } : null,
  );
  const [drag, setDrag] = useState<Drag | null>(null);
  // The row of palette, canvas and panel; held in state so the panel measures it once it renders.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const panel = usePanelWidth(PANEL, body);
  // A step removed or moved away leaves its panel with nothing to show.
  const shown = sel?.kind === 'step' && !working.steps[sel.index] ? null : sel;

  const known = [...(skills.data?.items ?? []), ...playbook.skills];
  const skillNames = ascending(
    working.skill_ids.map((id) => known.find((skill) => skill.id === id)?.name ?? 'A deleted Skill'),
    (name) => name,
  );
  const triggerLabels = playbook.triggers.map((trigger) => TRIGGER_LABELS[trigger].label);
  const full = working.steps.length >= PLAYBOOK_LIMITS.steps;
  const appendStep = (step: DraftStep) => {
    if (readOnly || full) return;
    onChange({ ...working, steps: [...working.steps, { ...step }] });
    setSel({ kind: 'step', index: working.steps.length });
  };
  // The empty Custom step leads the list: it is the one the operator writes themselves.
  const blocks = [...props.blocks].sort(
    (a, b) => Number(b.block === StepBlock.Custom) - Number(a.block === StepBlock.Custom),
  );

  const builtinTrigger = triggerOfBuiltin(playbook);
  const replacedBy = readOnly ? holderOf(props.items, builtinTrigger) : undefined;

  return (
    <section aria-label="Playbook" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <Button title="Back to the Triggers" onClick={props.onBack}>
          ← All Playbooks
        </Button>
        <input
          aria-label="Name"
          value={working.name}
          readOnly={readOnly}
          maxLength={PLAYBOOK_LIMITS.name}
          onChange={(event) => onChange({ ...working, name: event.target.value })}
          className="min-w-0 max-w-80 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 font-heading text-lg font-semibold text-text outline-none hover:border-divider focus:border-accent-400 read-only:hover:border-transparent"
        />
        {readOnly && (
          <span className="flex items-center gap-1 rounded-full bg-neutral-200 px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.04em] text-neutral-700 uppercase">
            <Lock />
            Read only
          </span>
        )}
        <span className="flex-1" />
        {props.dirty && (
          <>
            <span className="text-xs text-neutral-700">Unsaved edits</span>
            <Button
              title="Throw the edits away and go back to the saved Playbook"
              disabled={save.isPending}
              onClick={() => {
                setSel(null);
                props.onDiscard();
              }}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              disabled={save.isPending}
              onClick={() => save.mutate({ id: playbook.id, patch: working }, { onSuccess: props.onSaved })}
            >
              {save.isPending && <Spinner />}
              Save
            </Button>
          </>
        )}
        {!readOnly && (
          <Button
            className="text-accent-700"
            title="Delete this Playbook. Its Triggers go back to their built-ins. Asks first."
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        )}
      </div>
      {save.error && (
        <p role="alert" className="m-0 border-b border-line px-5 py-1.5 text-right text-xs text-accent-700">
          {save.error.message}
        </p>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${playbook.name}?`}
          action="Delete"
          pending={remove.isPending}
          error={remove.error?.message}
          onConfirm={() => remove.mutate(playbook.id, { onSuccess: props.onDeleted })}
          onCancel={() => {
            remove.reset();
            setConfirmDelete(false);
          }}
        >
          {triggerLabels.length > 0 &&
            `${inWords(triggerLabels)} ${triggerLabels.length === 1 ? 'goes' : 'go'} back to built-in. `}
          This can't be undone.
        </ConfirmDialog>
      )}
      {readOnly && (
        <p className="m-0 flex flex-none items-center gap-2.5 border-b border-line bg-accent-100/50 px-5 py-2 text-[13px]">
          <span className="flex size-5.5 flex-none items-center justify-center rounded-full bg-neutral-200 text-[11px] font-semibold">
            i
          </span>
          <span>
            <b>Built-in, read only.</b>{' '}
            {replacedBy ? (
              <>
                Replaced on <b>{TRIGGER_LABELS[builtinTrigger].label}</b> by <b>{replacedBy.name}</b>.
              </>
            ) : (
              <>
                The console runs this on <b>{TRIGGER_LABELS[builtinTrigger].label}</b> until you attach a Playbook of
                yours.
              </>
            )}{' '}
            <span className="text-neutral-700">
              The console updates its text; to change it, make a copy from <b>+ New Playbook</b>.
            </span>
          </span>
        </p>
      )}
      <div ref={setBody} className="flex min-h-0 flex-1">
        {!readOnly && <Palette blocks={blocks} full={full} drag={drag} setDrag={setDrag} onAdd={appendStep} />}
        <FlowCanvas
          playbook={playbook}
          working={working}
          skillNames={skillNames}
          readOnly={readOnly}
          sel={shown}
          onSelect={setSel}
          blocks={blocks}
          drag={drag}
          setDrag={setDrag}
          onChange={onChange}
        />
        {shown && (
          <ResizeHandle
            label="Resize the panel"
            width={panel.width}
            initial={PANEL.initial}
            narrowest={PANEL.narrowest}
            widest={panel.widest}
            onWidth={panel.setWidth}
          />
        )}
        {shown && (
          <Inspector
            width={panel.width}
            sel={shown}
            playbook={playbook}
            items={props.items}
            working={working}
            readOnly={readOnly}
            onChange={onChange}
            onClose={() => setSel(null)}
            onToggleTrigger={props.onToggleTrigger}
          />
        )}
      </div>
    </section>
  );
}
