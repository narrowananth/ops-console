import {
  JOB_TRIGGERS,
  PLAYBOOK_LIMITS,
  PLAYBOOK_TRIGGERS,
  type Playbook,
  type PlaybookTrigger,
  PR_DESCRIPTION_RULE,
  StepBlock,
  TRIGGER_LABELS,
} from '@ops-console/shared';
import { type DragEvent, useRef, useState } from 'react';
import { Button, Spinner } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { useCreatePlaybook, useDeletePlaybook, useSavePlaybook } from '../lib/queries';
import type { Draft, DraftStep } from './drafts';
import { type Drag, Grip, leftFor, startDrag } from './drag';
import { ScratchTag } from './job-steps';
import { CLOSING_TURN, chatOnly, freeName, inWords, triggerName } from './labels';

const small = 'px-2.5 py-1 text-xs';
const field =
  'w-full rounded-md border border-divider bg-card px-2.5 py-1.5 text-text outline-none focus:border-accent-400 read-only:bg-transparent';

/** The open Playbook: its name, the Triggers holding it, Rules, Steps, and Save while there are edits. */
export function PlaybookEditor(props: {
  playbook: Playbook;
  items: Playbook[];
  working: Draft;
  dirty: boolean;
  onChange: (next: Draft) => void;
  onDiscard: () => void;
  onSaved: () => void;
  onOpen: (id: string) => void;
  onDeleted: () => void;
  onAttach: (trigger: PlaybookTrigger) => void;
  onDetach: (trigger: PlaybookTrigger) => void;
  drag: Drag | null;
  setDrag: (drag: Drag | null) => void;
  onDropBlock: (step: DraftStep, at: number) => void;
}) {
  const { playbook, working, onChange, drag, setDrag } = props;
  const save = useSavePlaybook();
  const duplicate = useCreatePlaybook();
  const remove = useDeletePlaybook();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menu, setMenu] = useState<'attach' | 'detach' | null>(null);
  const [lineAt, setLineAt] = useState<number | null>(null);
  const cards = useRef<(HTMLLIElement | null)[]>([]);
  const readOnly = playbook.builtin;
  const steps = working.steps;
  const triggerLabels = playbook.triggers.map((trigger) => TRIGGER_LABELS[trigger].label);
  const closing = JOB_TRIGGERS.filter((trigger) => playbook.triggers.includes(trigger));
  const greyed = chatOnly(playbook.triggers);

  const setStep = (index: number, patch: Partial<DraftStep>) =>
    onChange({ ...working, steps: steps.map((step, at) => (at === index ? { ...step, ...patch } : step)) });
  const move = (from: number, to: number) => {
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    onChange({ ...working, steps: next });
  };
  const removeStep = (index: number) => onChange({ ...working, steps: steps.filter((_, at) => at !== index) });

  /** Where a dragged block or step would land: before the first card whose middle is below the pointer. */
  const dropIndex = (event: DragEvent) => {
    const at = cards.current
      .slice(0, steps.length)
      .findIndex((card) => card !== null && event.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2);
    return at === -1 ? steps.length : at;
  };
  const takesDrop =
    !readOnly && (drag?.kind === 'step' || (drag?.kind === 'block' && steps.length < PLAYBOOK_LIMITS.steps));

  return (
    <section aria-label="Playbook" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full max-w-180 flex-col gap-5 px-7 py-6">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Name"
              value={working.name}
              readOnly={readOnly}
              maxLength={PLAYBOOK_LIMITS.name}
              onChange={(event) => onChange({ ...working, name: event.target.value })}
              className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 font-heading text-lg font-extrabold text-text outline-none hover:border-divider focus:border-accent-400 read-only:hover:border-transparent"
            />
            {!readOnly && (
              <>
                <Button
                  className={small}
                  aria-expanded={menu === 'attach'}
                  onClick={() => setMenu(menu === 'attach' ? null : 'attach')}
                >
                  Attach to
                </Button>
                {playbook.triggers.length > 0 && (
                  <Button
                    className={small}
                    aria-expanded={menu === 'detach'}
                    onClick={() => setMenu(menu === 'detach' ? null : 'detach')}
                  >
                    Detach
                  </Button>
                )}
              </>
            )}
            <Button
              className={small}
              disabled={duplicate.isPending}
              onClick={() =>
                duplicate.mutate(
                  {
                    name: freeName(`Copy of ${playbook.name}`, props.items),
                    rules: playbook.rules,
                    branches: playbook.branches,
                    steps: playbook.steps,
                  },
                  { onSuccess: (made) => props.onOpen(made.id) },
                )
              }
            >
              Duplicate
            </Button>
            {!readOnly && (
              <Button className={`${small} text-accent-700`} onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </div>
          {menu && (
            <fieldset
              aria-label={menu === 'attach' ? 'Attach to' : 'Detach'}
              className="m-0 flex flex-wrap gap-1.5 border-0 px-1.5 py-0"
            >
              {(menu === 'attach'
                ? PLAYBOOK_TRIGGERS.filter((trigger) => !playbook.triggers.includes(trigger))
                : playbook.triggers
              ).map((trigger) => (
                <Button
                  key={trigger}
                  className={small}
                  onClick={() => {
                    setMenu(null);
                    if (menu === 'attach') props.onAttach(trigger);
                    else props.onDetach(trigger);
                  }}
                >
                  {triggerName(trigger)}
                </Button>
              ))}
            </fieldset>
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
          {duplicate.error && (
            <p role="alert" className="m-0 px-1.5 text-xs text-accent-700">
              {duplicate.error.message}
            </p>
          )}
          <div className="px-1.5 text-[13px] text-neutral-700">
            {playbook.triggers.length > 0 ? `On: ${playbook.triggers.map(triggerName).join(', ')}` : 'On no Trigger'}
          </div>
        </div>

        <section aria-label="Rules">
          <div className="mb-1.5 flex items-baseline gap-2">
            <h2 className="m-0 text-sm">Rules</h2>
            <span className="text-[11px] text-neutral-700">Every turn, after the console's own instructions</span>
            <span className="ml-auto font-mono text-[11px] text-neutral-700">
              {working.rules.length} / {PLAYBOOK_LIMITS.rules}
            </span>
          </div>
          <textarea
            aria-label="Rules"
            value={working.rules}
            readOnly={readOnly}
            maxLength={PLAYBOOK_LIMITS.rules}
            placeholder={readOnly ? 'No rules.' : 'What the agent should always do or never do on this Trigger'}
            onChange={(event) => onChange({ ...working, rules: event.target.value })}
            className={`${field} min-h-18 resize-y text-[13px]`}
          />
          <details className="mt-1.5 text-[11px] text-neutral-700">
            <summary className="cursor-pointer">
              Every run also gets the console's pull request description rule, before these rules
            </summary>
            <p className="m-0 mt-1 whitespace-pre-wrap rounded-lg border border-line bg-surface/40 px-3 py-2">
              {PR_DESCRIPTION_RULE}
            </p>
          </details>
        </section>

        <section aria-label="Branch">
          <div className="mb-1.5 flex items-baseline gap-2">
            <h2 className="m-0 text-sm">Branch</h2>
            <span className="text-[11px] text-neutral-700">
              Where Verify and Fix read the code: the first of these origin has, fetched first
            </span>
          </div>
          <input
            aria-label="Branch"
            value={working.branches}
            readOnly={readOnly}
            maxLength={PLAYBOOK_LIMITS.branches}
            placeholder={
              readOnly ? "The Repo's default branch" : "production, master, main  ·  blank: the Repo's default branch"
            }
            onChange={(event) => onChange({ ...working, branches: event.target.value })}
            className={`${field} font-mono text-[13px]`}
          />
        </section>

        <section aria-label="Steps">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="m-0 text-sm">Steps</h2>
            <span className="text-[11px] text-neutral-700">Each step is its own agent turn, in order</span>
            <span className="ml-auto font-mono text-[11px] text-neutral-700">
              {steps.length} / {PLAYBOOK_LIMITS.steps}
            </span>
          </div>
          {greyed && <p className="m-0 mb-2 text-xs text-neutral-700">Steps don't run on chat Triggers.</p>}
          <ol
            aria-label="Steps"
            onDragOver={(event) => {
              if (!takesDrop) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setLineAt(dropIndex(event));
            }}
            onDragLeave={(event) => {
              if (leftFor(event)) setLineAt(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const at = dropIndex(event);
              setLineAt(null);
              if (drag?.kind === 'block') props.onDropBlock(drag.step, at);
              if (drag?.kind === 'step') move(drag.index, at > drag.index ? at - 1 : at);
            }}
            className={`m-0 flex min-h-12 list-none flex-col gap-2 p-0 ${greyed ? 'opacity-50' : ''}`}
          >
            {steps.length === 0 && lineAt === null && (
              <li className="rounded-lg border border-dashed border-divider px-3 py-3 text-xs text-neutral-700">
                {readOnly
                  ? 'No steps: the agent answers with the rules alone.'
                  : 'No steps. Drag a block here, or press + on one.'}
              </li>
            )}
            {steps.map((step, index) => (
              <StepCard
                // Inputs are controlled, so a card moved to another index shows its own text.
                // biome-ignore lint/suspicious/noArrayIndexKey: steps have no id until saved
                key={index}
                cardRef={(card) => {
                  cards.current[index] = card;
                }}
                step={step}
                index={index}
                count={steps.length}
                readOnly={readOnly}
                lineBefore={lineAt === index}
                dragging={drag?.kind === 'step' && drag.index === index}
                onDragStart={(event) => startDrag(event, { kind: 'step', index }, setDrag)}
                onDragEnd={(event) => {
                  // Let go outside Steps: the step is removed (Behavior 8).
                  if (event.dataTransfer.dropEffect === 'none') removeStep(index);
                  setLineAt(null);
                  setDrag(null);
                }}
                onChange={(patch) => setStep(index, patch)}
                onMove={(to) => move(index, to)}
                onRemove={() => removeStep(index)}
              />
            ))}
            {lineAt === steps.length && <DropLine />}
          </ol>
          {closing.length > 0 && (
            <div className="mt-2.5 flex flex-col gap-0.5 rounded-lg border border-dashed border-divider px-3 py-2 text-xs text-neutral-700">
              <span>Then the console's own turn:</span>
              {closing.map((trigger) => (
                <span key={trigger}>
                  {TRIGGER_LABELS[trigger].label}: {CLOSING_TURN[trigger]}.
                </span>
              ))}
            </div>
          )}
        </section>
      </div>
      {props.dirty && (
        <div className="sticky bottom-0 mt-auto flex flex-col gap-1 border-t border-line bg-card px-7 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-700">Unsaved edits</span>
            <span className="flex-1" />
            <Button className={small} disabled={save.isPending} onClick={props.onDiscard}>
              Discard
            </Button>
            <Button
              variant="primary"
              className={small}
              disabled={save.isPending}
              onClick={() => save.mutate({ id: playbook.id, patch: working }, { onSuccess: props.onSaved })}
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

function DropLine() {
  return <li role="presentation" className="h-0 rounded-xs border-t-2 border-accent" />;
}

const actionButton =
  'size-6 cursor-pointer rounded-sm border-0 bg-transparent p-0 text-neutral-600 hover:bg-neutral-200 hover:text-text disabled:cursor-not-allowed disabled:opacity-40';

function StepCard(props: {
  cardRef: (card: HTMLLIElement | null) => void;
  step: DraftStep;
  index: number;
  count: number;
  readOnly: boolean;
  lineBefore: boolean;
  dragging: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: (event: DragEvent) => void;
  onChange: (patch: Partial<DraftStep>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const { step, index, readOnly } = props;
  return (
    <>
      {props.lineBefore && <DropLine />}
      <li
        ref={props.cardRef}
        aria-label={`Step ${index + 1}`}
        className={`flex items-start gap-2.5 rounded-lg border border-line bg-card px-3 py-2.5 shadow-sm ${props.dragging ? 'opacity-40' : ''}`}
      >
        {!readOnly && (
          // biome-ignore lint/a11y/noStaticElementInteractions: a drag handle; Move up, Move down and Remove are its keyboard path
          <span
            draggable
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            className="pt-1.5"
            title="Drag to reorder"
          >
            <Grip />
          </span>
        )}
        <span className="mt-1 flex size-5.5 flex-none items-center justify-center rounded-full bg-neutral-200 text-[11px] font-bold">
          {index + 1}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <input
              aria-label="Step title"
              value={step.title}
              readOnly={readOnly}
              maxLength={PLAYBOOK_LIMITS.title}
              onChange={(event) => props.onChange({ title: event.target.value })}
              className={`${field} text-[13px] font-bold`}
            />
            {step.block === StepBlock.Custom && !readOnly ? (
              <label className="flex flex-none items-center gap-1 text-[11px] text-neutral-700">
                <input
                  type="checkbox"
                  checked={step.writes}
                  onChange={(event) => props.onChange({ writes: event.target.checked })}
                />
                scratch copy
              </label>
            ) : (
              step.writes && <ScratchTag />
            )}
          </div>
          <textarea
            aria-label="Step instructions"
            value={step.instructions}
            readOnly={readOnly}
            maxLength={PLAYBOOK_LIMITS.instructions}
            placeholder="Write what the agent does in this step."
            onChange={(event) => props.onChange({ instructions: event.target.value })}
            className={`${field} min-h-16 resize-y text-xs`}
          />
        </div>
        {!readOnly && (
          <div className="flex flex-none gap-0.5">
            <button
              type="button"
              aria-label="Move up"
              title="Move up"
              disabled={index === 0}
              onClick={() => props.onMove(index - 1)}
              className={actionButton}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Move down"
              title="Move down"
              disabled={index === props.count - 1}
              onClick={() => props.onMove(index + 1)}
              className={actionButton}
            >
              ↓
            </button>
            <button type="button" aria-label="Remove" title="Remove" onClick={props.onRemove} className={actionButton}>
              ×
            </button>
          </div>
        )}
      </li>
    </>
  );
}
