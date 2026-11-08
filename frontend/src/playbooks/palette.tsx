import { PLAYBOOK_LIMITS } from '@ops-console/shared';
import type { DraftStep } from './drafts';
import { type Drag, Grip, startDrag } from './drag';
import { ScratchTag } from './job-steps';

/** The Step blocks: drag one onto a line of the flow, or press + to add a copy at the end. */
export function Palette(props: {
  blocks: DraftStep[];
  full: boolean;
  drag: Drag | null;
  setDrag: (drag: Drag | null) => void;
  onAdd: (step: DraftStep) => void;
}) {
  const { full, drag } = props;
  return (
    <aside
      aria-label="Step blocks"
      className="flex w-62 flex-none flex-col gap-1.5 overflow-y-auto border-r border-line bg-surface/40 px-3 py-4"
    >
      <div className="px-1 text-xs font-semibold tracking-[0.08em] text-neutral-600 uppercase">Step blocks</div>
      <p className="m-0 mb-1 px-1 text-xs text-neutral-700">
        Ready-made steps. Drag one onto a line in the flow, or press +. The copy is yours to edit.
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {props.blocks.map((block) => (
          <li
            key={block.block}
            aria-label={block.title}
            title={block.instructions || 'An empty step to write yourself.'}
            draggable
            onDragStart={(event) => startDrag(event, { kind: 'block', step: block }, props.setDrag)}
            onDragEnd={() => props.setDrag(null)}
            className={`flex cursor-grab items-center gap-2 rounded-lg border border-line bg-card px-2.5 py-2 text-xs shadow-sm hover:border-accent-300 ${
              drag?.kind === 'block' && drag.step.block === block.block ? 'opacity-40' : ''
            }`}
          >
            <Grip />
            <span className="min-w-0 flex-1 truncate">{block.title}</span>
            {block.writes && <ScratchTag />}
            <button
              type="button"
              aria-label={`Add ${block.title} to steps`}
              title={
                full
                  ? `A Playbook holds ${PLAYBOOK_LIMITS.steps} steps at most. Remove one first.`
                  : 'Add to the end of the flow'
              }
              disabled={full}
              onClick={() => props.onAdd(block)}
              className="size-5.5 flex-none cursor-pointer rounded-sm border-0 bg-transparent p-0 font-semibold text-accent hover:bg-accent-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              +
            </button>
          </li>
        ))}
      </ul>
      <p className="m-0 mt-1 px-1 text-xs text-neutral-700">
        <ScratchTag /> steps write files or run commands in a scratch copy, never in your own checkout.
      </p>
      <p className="m-0 mt-1 px-1 text-xs text-neutral-700">
        Keyboard: on a focused step, Alt+←/→ moves it and Delete removes it.
      </p>
    </aside>
  );
}
