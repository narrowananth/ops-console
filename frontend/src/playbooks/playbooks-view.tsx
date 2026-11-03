import {
  PLAYBOOK_LIMITS,
  PLAYBOOK_TRIGGERS,
  type Playbook,
  type PlaybookTrigger,
  TRIGGER_LABELS,
} from '@ops-console/shared';
import { type DragEvent, type ReactNode, useState } from 'react';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Dropdown, type DropdownOption } from '../components/ui/dropdown';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { Hint } from '../components/ui/tip';
import { useCreatePlaybook, usePlaybooks, useSetTrigger } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { ascending } from '../lib/sort';
import { type Draft, type DraftStep, draftOf, useDrafts } from './drafts';
import { type Drag, Grip, leftFor, startDrag } from './drag';
import { ScratchTag } from './job-steps';
import { builtinFor, freeName, holderOf, TRIGGER_TIPS } from './labels';
import { PlaybookEditor } from './playbook-editor';

function Caption({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 mb-1 px-2 text-xs font-semibold tracking-[0.08em] text-neutral-600 uppercase first:mt-0">
      {children}
    </div>
  );
}

/** In the page header: a new empty Playbook, opened at once. */
export function NewPlaybookButton() {
  const list = usePlaybooks();
  const create = useCreatePlaybook();
  const [, setAddress] = useAddress('playbook');
  return (
    <>
      {create.error && (
        <span role="alert" className="text-xs text-accent-700">
          {create.error.message}
        </span>
      )}
      <Button
        disabled={!list.data || create.isPending}
        onClick={() =>
          list.data &&
          create.mutate(
            { name: freeName('New Playbook', list.data.items), rules: '', branches: '', jira_ticket: false, steps: [] },
            { onSuccess: (made) => setAddress({ playbook: made.id }) },
          )
        }
      >
        + New Playbook
      </Button>
    </>
  );
}

export function PlaybooksView() {
  const list = usePlaybooks();
  const [address, setAddress] = useAddress('playbook');
  const { drafts, edit, drop } = useDrafts();
  const [drag, setDrag] = useState<Drag | null>(null);
  const setTrigger = useSetTrigger();
  const [replacing, setReplacing] = useState<{ trigger: PlaybookTrigger; from: Playbook; to: Playbook } | null>(null);

  if (list.isPending) return <Empty>Reading Playbooks…</Empty>;
  if (list.isError) return <Empty>Could not read Playbooks: {list.error.message}</Empty>;
  const { items, blocks } = list.data;
  const open = items.find((playbook) => playbook.id === address.playbook) ?? items[0];
  if (!open) return <Empty>Could not read Playbooks: the daemon sent none.</Empty>;
  const working: Draft = drafts[open.id] ?? draftOf(open);
  const change = (next: Draft) => edit(open, next);
  const full = working.steps.length >= PLAYBOOK_LIMITS.steps;
  const addStep = (step: DraftStep, at = working.steps.length) => {
    if (open.builtin || full) return;
    change({ ...working, steps: [...working.steps.slice(0, at), { ...step }, ...working.steps.slice(at)] });
  };

  const detach = (trigger: PlaybookTrigger) => setTrigger.mutate({ trigger, playbookId: null });
  /** Attaching over another Playbook asks first (Behavior 5). */
  const attach = (trigger: PlaybookTrigger, playbook: Playbook) => {
    const current = holderOf(items, trigger);
    if (current?.id === playbook.id) return;
    if (current) setReplacing({ trigger, from: current, to: playbook });
    else setTrigger.mutate({ trigger, playbookId: playbook.id });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <TriggersColumn
        items={items}
        openId={open.id}
        drafts={drafts}
        drag={drag}
        setDrag={setDrag}
        onOpen={(id) => setAddress({ playbook: id })}
        onAttach={attach}
        onDetach={detach}
        error={setTrigger.error?.message ?? null}
      />
      {replacing && (
        <ConfirmDialog
          title={`Replace ${replacing.from.name}?`}
          action="Replace"
          onConfirm={() => {
            setTrigger.mutate({ trigger: replacing.trigger, playbookId: replacing.to.id });
            setReplacing(null);
          }}
          onCancel={() => setReplacing(null)}
        >
          {TRIGGER_LABELS[replacing.trigger].label} runs {replacing.from.name}. Replace it with {replacing.to.name}?
        </ConfirmDialog>
      )}
      <PlaybookEditor
        key={open.id}
        playbook={open}
        items={items}
        working={working}
        dirty={drafts[open.id] !== undefined}
        onChange={change}
        onDiscard={() => drop(open.id)}
        onSaved={() => drop(open.id)}
        onOpen={(id) => setAddress({ playbook: id })}
        onDeleted={() => {
          drop(open.id);
          setAddress({ playbook: null }, { replace: true });
        }}
        onAttach={(trigger) => attach(trigger, open)}
        onDetach={detach}
        drag={drag}
        setDrag={setDrag}
        onDropBlock={addStep}
      />
      <aside
        aria-label="Step blocks"
        className="flex w-67 flex-none flex-col gap-1.5 overflow-y-auto border-l border-line bg-surface/40 px-3 py-4"
      >
        <Caption>
          Step blocks{' '}
          <Hint text="Ready-made steps. Drag one into Steps or press + to add a copy you can then edit. Hover a block to read what it tells the agent." />
        </Caption>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {blocks.map((block) => (
            <li
              key={block.block}
              aria-label={block.title}
              draggable={!open.builtin}
              onDragStart={(event) => startDrag(event, { kind: 'block', step: block }, setDrag)}
              onDragEnd={() => setDrag(null)}
              className={`group relative flex flex-col gap-1 rounded-lg border border-line bg-card px-2.5 py-2 text-xs shadow-sm hover:border-accent-300 ${
                open.builtin ? '' : 'cursor-grab'
              } ${drag?.kind === 'block' && drag.step.block === block.block ? 'opacity-40' : ''}`}
            >
              <div className="flex items-center gap-2">
                <Grip />
                <span className="min-w-0 flex-1 truncate">{block.title}</span>
                {block.writes && <ScratchTag />}
                <button
                  type="button"
                  aria-label={`Add ${block.title} to steps`}
                  title={
                    open.builtin
                      ? 'A built-in reads only. Duplicate it to edit the copy.'
                      : full
                        ? `A Playbook holds ${PLAYBOOK_LIMITS.steps} steps at most. Remove one first.`
                        : 'Add to the end of Steps'
                  }
                  disabled={open.builtin || full}
                  onClick={() => addStep(block)}
                  className="size-5.5 flex-none cursor-pointer rounded-sm border-0 bg-transparent p-0 font-semibold text-accent hover:bg-accent-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  +
                </button>
              </div>
              {/* Floats over the blocks below and lets the pointer through, so showing it moves nothing. */}
              <p className="pointer-events-none absolute top-full right-0 left-0 z-10 m-0 mt-1 hidden rounded-lg border border-line bg-card px-2.5 py-2 text-neutral-700 shadow-md group-focus-within:block group-hover:block">
                {block.instructions || 'An empty step to write yourself.'}
              </p>
            </li>
          ))}
        </ul>
        <p className="mx-1 mt-1.5 mb-0 text-xs text-neutral-700">
          Drag a block into Steps, or press +. The dropped copy is yours to edit. <ScratchTag /> steps write files or
          run commands in a scratch copy, never in your own checkout.
        </p>
      </aside>
    </div>
  );
}

/** The Dropdown value for a Trigger running its built-in. */
const BUILT_IN = '';

const stepCount = (playbook: Playbook | undefined) => {
  if (!playbook) return undefined;
  const count = playbook.steps.length;
  return count === 0 ? 'rules only' : `${count} ${count === 1 ? 'step' : 'steps'}`;
};

const TABS = [...new Set(PLAYBOOK_TRIGGERS.map((trigger) => TRIGGER_LABELS[trigger].tab))];

function TriggersColumn(props: {
  items: Playbook[];
  openId: string;
  drafts: Record<string, Draft>;
  drag: Drag | null;
  setDrag: (drag: Drag | null) => void;
  onOpen: (id: string) => void;
  onAttach: (trigger: PlaybookTrigger, playbook: Playbook) => void;
  onDetach: (trigger: PlaybookTrigger) => void;
  error: string | null;
}) {
  const { items, openId, drafts, drag, setDrag, onOpen, onAttach, onDetach } = props;
  const [over, setOver] = useState<PlaybookTrigger | null>(null);
  const own = ascending(
    items.filter((playbook) => !playbook.builtin),
    (playbook) => playbook.name,
  );
  const builtins = items.filter((playbook) => playbook.builtin);
  const beginDrag = (event: DragEvent, next: Drag) => startDrag(event, next, setDrag);

  const choices = (trigger: PlaybookTrigger): DropdownOption<string>[] => [
    { value: BUILT_IN, label: 'Built-in', description: stepCount(builtinFor(items, trigger)) },
    ...own.map((playbook) => ({
      value: playbook.id,
      label: playbook.name,
      description: stepCount(playbook),
    })),
  ];
  /** Built-in detaches; a Playbook attaches. */
  const pick = (trigger: PlaybookTrigger, id: string) => {
    if (id === BUILT_IN) return onDetach(trigger);
    const playbook = own.find((candidate) => candidate.id === id);
    if (playbook) onAttach(trigger, playbook);
  };

  const slot = (trigger: PlaybookTrigger) => {
    const holder = holderOf(items, trigger);
    // A chip let go on its own Trigger stays; anywhere else it detaches.
    const ownChip = drag?.kind === 'chip' && drag.trigger === trigger;
    const accepts = drag?.kind === 'playbook' || ownChip;
    return (
      <li
        key={trigger}
        aria-label={TRIGGER_LABELS[trigger].label}
        draggable={holder !== undefined}
        title={holder ? 'Drag off to put the built-in back' : undefined}
        onDragStart={(event) => beginDrag(event, { kind: 'chip', trigger })}
        onDragEnd={(event) => {
          if (event.dataTransfer.dropEffect === 'none') onDetach(trigger);
          setDrag(null);
        }}
        onDragOver={(event) => {
          if (drag?.kind !== 'playbook' && !ownChip) return;
          setOver(trigger);
          if (accepts) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }
        }}
        onDragLeave={(event) => leftFor(event) && setOver(null)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(null);
          if (drag?.kind === 'playbook') onAttach(trigger, drag.playbook);
        }}
        className={`flex items-center gap-2 rounded-lg border py-1.5 pr-1.5 pl-2.5 text-[13px] transition-colors ${
          holder ? 'cursor-grab' : ''
        } ${
          over === trigger && drag?.kind === 'playbook'
            ? 'border-accent-400 bg-accent-100'
            : 'border-dashed border-divider'
        }`}
      >
        <b title={TRIGGER_TIPS[trigger]} className="min-w-0 flex-1 truncate">
          {TRIGGER_LABELS[trigger].label}
        </b>
        <Dropdown
          label={`${TRIGGER_LABELS[trigger].label} runs`}
          value={holder?.id ?? BUILT_IN}
          options={choices(trigger)}
          onChange={(id) => pick(trigger, id)}
          className="w-36 flex-none"
          listClassName="w-64"
          heading={`${TRIGGER_LABELS[trigger].label} runs`}
        />
      </li>
    );
  };

  const row = (playbook: Playbook) => (
    <li key={playbook.id}>
      <button
        type="button"
        draggable={!playbook.builtin}
        aria-current={playbook.id === openId ? 'true' : undefined}
        title={playbook.builtin ? undefined : 'Open it, or drag it onto a Trigger'}
        onClick={() => onOpen(playbook.id)}
        onDragStart={(event) => beginDrag(event, { kind: 'playbook', playbook })}
        onDragEnd={() => {
          setOver(null);
          setDrag(null);
        }}
        className={`flex w-full items-center gap-2 px-2.5 py-2 text-[13px] ${item(playbook.id === openId)} ${
          drag?.kind === 'playbook' && drag.playbook.id === playbook.id ? 'opacity-40' : ''
        }`}
      >
        {!playbook.builtin && <Grip />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{playbook.name}</span>
          <span className="truncate text-xs text-neutral-700">
            {playbook.builtin
              ? `built-in · ${stepCount(playbook)}`
              : playbook.triggers.map((trigger) => TRIGGER_LABELS[trigger].label).join(', ')}
          </span>
        </span>
        {drafts[playbook.id] && (
          <span
            role="img"
            aria-label="Unsaved edits"
            title="Unsaved edits. Save or Discard them in the Playbook."
            className="size-1.75 flex-none rounded-full bg-accent"
          />
        )}
      </button>
    </li>
  );

  return (
    <aside
      aria-label="Triggers and Playbooks"
      className="flex w-80 flex-none flex-col gap-1 overflow-y-auto border-r border-line px-3 py-4"
    >
      <section aria-label="Triggers">
        <Caption>
          Triggers{' '}
          <Hint text="The places in Monitor and Workspace that start the agent. Each runs one Playbook: its built-in, or one of yours you pick here." />
        </Caption>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {TABS.map((tab) => (
            <li key={tab} className="flex flex-col gap-1.5">
              <div className="px-2 pt-1.5 pb-0.5 text-xs font-semibold text-neutral-700">{tab}</div>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {PLAYBOOK_TRIGGERS.filter((trigger) => TRIGGER_LABELS[trigger].tab === tab).map(slot)}
              </ul>
            </li>
          ))}
        </ul>
        {props.error && (
          <p role="alert" className="mx-2 mt-1.5 mb-0 text-xs text-accent-700">
            {props.error}
          </p>
        )}
        <p className="mx-2 mt-1.5 mb-0 text-xs text-neutral-700">
          Pick a Playbook for a Trigger, or drag one onto it. Drag a Trigger off to put the built-in back.
        </p>
      </section>
      <section aria-label="Playbooks" className="mt-2">
        <Caption>
          Playbooks{' '}
          <Hint text="Your own Playbooks: rules and steps you write. Drag one onto a Trigger to make that Trigger run it." />
        </Caption>
        {own.length === 0 ? (
          <p className="mx-2 my-1 text-xs text-neutral-700">
            No Playbooks yet. Duplicate a built-in or start a new one.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{own.map(row)}</ul>
        )}
        <Caption>
          Built-in{' '}
          <Hint text="The console's own Playbook for each Trigger. It runs when the Trigger holds none of yours. It reads only: Duplicate it to change it." />
        </Caption>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{builtins.map(row)}</ul>
      </section>
    </aside>
  );
}
