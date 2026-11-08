import {
  PLAYBOOK_LIMITS,
  type Playbook,
  type PlaybookTrigger,
  SKILL_LIMITS,
  TRIGGER_LABELS,
} from '@ops-console/shared';
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Draft, DraftStep } from './drafts';
import { type Drag, leftFor, startDrag } from './drag';
import { type FlowNode, layoutFlow, NODE } from './flow-layout';
import { ScratchTag } from './job-steps';
import { CLOSING_TURN, chatOnly } from './labels';
import { Lock } from './lock';

/** What the panel on the right shows: the node the operator picked. */
export type Sel =
  | { kind: 'trigger' }
  | { kind: 'step'; index: number }
  | { kind: 'rules' }
  | { kind: 'skills' }
  | { kind: 'settings' };

const same = (a: Sel | null, b: Sel) =>
  a?.kind === b.kind && (a.kind !== 'step' || (b.kind === 'step' && a.index === b.index));

const CARD = 'absolute flex flex-col gap-1.5 overflow-hidden rounded-lg border bg-card p-4 text-left shadow-sm';
const idle = 'border-line hover:border-accent-300';
const picked = 'border-accent shadow-[0_0_0_3px_var(--color-accent-100)]';

const CONTEXT_TOP = 16;
const CONTEXT_H = 68;
const BUS_Y = 106;
const FLOW_TOP = 138;

/**
 * The Playbook as a picture of its run: the Trigger, each step in order, the console's own turn, and above them the
 * Rules, Skills and Settings that apply to every turn. A step moves by drag or by Alt and the arrow keys.
 */
export function FlowCanvas(props: {
  playbook: Playbook;
  working: Draft;
  skillNames: string[];
  readOnly: boolean;
  sel: Sel | null;
  onSelect: (sel: Sel | null) => void;
  blocks: DraftStep[];
  drag: Drag | null;
  setDrag: (drag: Drag | null) => void;
  onChange: (next: Draft) => void;
}) {
  const { playbook, working, readOnly, sel, drag, setDrag } = props;
  const outer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusAt = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [hot, setHot] = useState<number | null>(null);
  const [adding, setAdding] = useState<number | null>(null);

  useLayoutEffect(() => {
    const box = outer.current;
    if (!box) return;
    const read = () => setWidth(box.clientWidth);
    read();
    const watch = new ResizeObserver(read);
    watch.observe(box);
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    if (focusAt.current === null) return;
    nodeRefs.current[focusAt.current + 1]?.focus();
    focusAt.current = null;
  });

  useEffect(() => {
    if (adding === null) return;
    const close = (event: MouseEvent) => {
      if (!(event.target instanceof Element && event.target.closest('[data-block-menu], [data-slot]'))) setAdding(null);
    };
    const key = (event: globalThis.KeyboardEvent) => event.key === 'Escape' && setAdding(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [adding]);

  const steps = working.steps;
  const triggers = playbook.triggers;
  const greyed = chatOnly(triggers);
  const closing = triggers.filter((trigger) => CLOSING_TURN[trigger]);
  const empty = steps.length === 0 && !readOnly;
  const full = steps.length >= PLAYBOOK_LIMITS.steps;
  const canvasWidth = Math.max(width, 320);
  const nodes: FlowNode[] = [
    { kind: 'trigger' },
    ...(empty ? [{ kind: 'empty' } as const] : steps.map((_, index) => ({ kind: 'step', index }) as const)),
    { kind: closing.length > 0 ? 'closing' : 'end' },
  ];
  const { placed, edges, height } = layoutFlow(nodes, canvasWidth, FLOW_TOP);

  const insert = (step: DraftStep, at: number) => {
    if (full) return;
    props.onChange({ ...working, steps: [...steps.slice(0, at), { ...step }, ...steps.slice(at)] });
    setAdding(null);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    focusAt.current = to;
    props.onChange({ ...working, steps: next });
  };
  const remove = (index: number) => {
    props.onChange({ ...working, steps: steps.filter((_, at) => at !== index) });
    props.onSelect(null);
  };

  // Every gap between two nodes takes a step; with none yet, the one "Add the first step" node does.
  const slots = empty
    ? [{ at: 0, x: (placed[1]?.x ?? 0) + NODE.w / 2, y: (placed[1]?.y ?? 0) + NODE.h / 2 }]
    : edges.map((edge) => ({ at: edge.at, x: edge.x, y: edge.y }));
  const nearest = (event: DragEvent) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return steps.length;
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    let best = slots[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const slot of slots) {
      const distance = (slot.x - x) ** 2 + (slot.y - y) ** 2;
      if (distance < bestDistance) {
        best = slot;
        bestDistance = distance;
      }
    }
    return best?.at ?? steps.length;
  };
  const takesDrop = !readOnly && (drag?.kind === 'step' || (drag?.kind === 'block' && !full));

  const onNodeKey = (event: KeyboardEvent, index: number) => {
    if (readOnly) return;
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      move(index, index + (event.key === 'ArrowLeft' ? -1 : 1));
    } else if (event.key === 'Delete') {
      event.preventDefault();
      remove(index);
    }
  };

  const contextWidth = Math.min(236, Math.floor((canvasWidth - NODE.pad * 2 - 24) / 3));
  const contextCards: { sel: Sel; label: string; text: string; meta: string }[] = [
    {
      sel: { kind: 'rules' },
      label: 'Rules',
      text:
        working.rules || (readOnly ? 'No rules.' : 'None yet. Click to write what the agent must always or never do.'),
      meta: `${working.rules.length} / ${PLAYBOOK_LIMITS.rules}`,
    },
    {
      sel: { kind: 'skills' },
      label: 'Skills',
      text:
        props.skillNames.length > 0
          ? props.skillNames.join(', ')
          : readOnly
            ? 'A built-in holds none.'
            : 'None. Click to add a method the agent can load.',
      meta: readOnly ? '' : `${working.skill_ids.length} / ${SKILL_LIMITS.perPlaybook}`,
    },
    {
      sel: { kind: 'settings' },
      label: 'Settings',
      text: `Branch: ${working.branches || "the Repo's default"} · Jira ticket ${working.jira_ticket ? 'on' : 'off'}`,
      meta: '',
    },
  ];
  const busLeft = NODE.pad + contextWidth / 2;
  const busRight = NODE.pad + 2 * (contextWidth + 12) + contextWidth / 2;

  const triggerNames = (list: PlaybookTrigger[]) => list.map((trigger) => TRIGGER_LABELS[trigger].label);
  const render = (node: FlowNode, k: number): ReactNode => {
    const at = placed[k];
    if (!at) return null;
    const box = { left: at.x, top: at.y, width: NODE.w, height: NODE.h };
    if (node.kind === 'trigger') {
      const shown = triggerNames(triggers);
      const none = shown.length === 0;
      return (
        <button
          key="trigger"
          type="button"
          ref={(element) => {
            nodeRefs.current[0] = element;
          }}
          aria-label="Trigger"
          onClick={() => props.onSelect({ kind: 'trigger' })}
          style={box}
          className={`${CARD} cursor-pointer ${none && !readOnly ? 'border-accent-300 bg-accent-100/60' : ''} ${
            same(sel, { kind: 'trigger' }) ? picked : idle
          }`}
        >
          <span className="text-[10px] font-semibold tracking-[0.08em] text-accent-700 uppercase">
            Trigger{readOnly ? ' · built-in' : ''}
          </span>
          <span className="flex flex-wrap gap-1">
            {shown.slice(0, 3).map((name) => (
              <span key={name} className="rounded-full bg-accent px-2 py-px text-[11px] font-semibold text-white">
                {name}
              </span>
            ))}
            {shown.length > 3 && (
              <span className="rounded-full bg-neutral-200 px-2 py-px text-[11px]">+{shown.length - 3}</span>
            )}
          </span>
          <span className="text-xs text-neutral-700">
            {none
              ? readOnly
                ? 'Replaced by a Playbook of yours.'
                : 'Runs on no Trigger yet. Click to choose one, or the agent never uses it.'
              : readOnly
                ? 'Runs until you attach one of yours.'
                : 'Click to change the Triggers that start this Playbook.'}
          </span>
        </button>
      );
    }
    if (node.kind === 'empty') {
      return (
        <button
          key="empty"
          type="button"
          onClick={() => setAdding(adding === 0 ? null : 0)}
          data-slot
          style={box}
          className={`${CARD} cursor-pointer items-center justify-center border-dashed border-divider text-center hover:border-accent-300`}
        >
          <span className="text-xl leading-none text-accent">+</span>
          <b className="text-[13px]">Add the first step</b>
          <span className="text-xs text-neutral-700">Drag a block here, or click</span>
        </button>
      );
    }
    if (node.kind === 'closing' || node.kind === 'end') {
      return (
        <div
          key={node.kind}
          style={box}
          title="After your steps the console runs one more turn itself. It is not a step: you cannot move or remove it."
          className={`${CARD} border-dashed border-divider bg-transparent shadow-none`}
        >
          <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-neutral-700 uppercase">
            <span className="flex size-4.5 flex-none items-center justify-center rounded-full bg-neutral-200 text-[10px]">
              ✓
            </span>
            {node.kind === 'closing' ? "Console's own turn" : 'End'}
          </span>
          <span className="text-xs text-neutral-700">
            {node.kind === 'closing'
              ? closing.map((trigger) => `${TRIGGER_LABELS[trigger].label}: ${CLOSING_TURN[trigger]}`).join(' · ')
              : greyed
                ? "Steps don't run on chat Triggers: the agent replies using the rules."
                : triggers.length > 0
                  ? 'The run ends here.'
                  : 'Where the run ends.'}
          </span>
        </div>
      );
    }
    const step = steps[node.index];
    if (!step) return null;
    const index = node.index;
    return (
      <button
        key={`step-${index}`}
        type="button"
        ref={(element) => {
          nodeRefs.current[k] = element;
        }}
        aria-label={`Step ${index + 1}`}
        draggable={!readOnly}
        onDragStart={(event) => startDrag(event, { kind: 'step', index }, setDrag)}
        onDragEnd={(event) => {
          if (event.dataTransfer.dropEffect === 'none') remove(index);
          setHot(null);
          setDrag(null);
        }}
        onClick={() => props.onSelect({ kind: 'step', index })}
        onKeyDown={(event) => onNodeKey(event, index)}
        style={box}
        className={`${CARD} cursor-pointer ${same(sel, { kind: 'step', index }) ? picked : idle} ${greyed ? 'opacity-60' : ''} ${
          drag?.kind === 'step' && drag.index === index ? 'opacity-40' : ''
        }`}
      >
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-neutral-700 uppercase">
          <span className="flex size-4.5 flex-none items-center justify-center rounded-full bg-neutral-200 text-[10px]">
            {index + 1}
          </span>
          Step
          {readOnly && !step.writes && <Lock />}
          {step.writes && (
            <span className="ml-auto">
              <ScratchTag />
            </span>
          )}
        </span>
        <span className="line-clamp-2 shrink-0 text-[13px] leading-tight font-semibold">
          {step.title || 'Untitled step'}
        </span>
        <span className="line-clamp-2 text-xs text-neutral-700">
          {step.instructions || 'Empty: write what the agent does.'}
        </span>
      </button>
    );
  };

  const menuAt = slots.find((slot) => slot.at === adding);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <section
        ref={outer}
        aria-label="Flow"
        onClick={(event) => {
          if (event.target === event.currentTarget || event.target === stage.current) props.onSelect(null);
        }}
        onKeyDown={(event) => event.key === 'Escape' && adding === null && props.onSelect(null)}
        className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle,var(--color-neutral-400)_1px,transparent_1px)] bg-size-[18px_18px]"
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the + buttons and Alt+arrows are the keyboard path */}
        <div
          ref={stage}
          onDragOver={(event) => {
            if (!takesDrop) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setHot(nearest(event));
          }}
          onDragLeave={(event) => {
            if (leftFor(event)) setHot(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const at = hot ?? nearest(event);
            setHot(null);
            if (drag?.kind === 'block') insert(drag.step, at);
            if (drag?.kind === 'step') move(drag.index, at > drag.index ? at - 1 : at);
          }}
          style={{ width: canvasWidth, height, minHeight: '100%' }}
          className="relative"
        >
          <svg aria-hidden width={canvasWidth} height={height} className="absolute inset-0">
            <defs>
              <marker
                id="flow-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: 'var(--color-neutral-500)' }} />
              </marker>
            </defs>
            {edges.map((edge) => (
              <path
                key={edge.at}
                d={edge.d}
                fill="none"
                stroke="var(--color-neutral-500)"
                strokeWidth="1.5"
                markerEnd="url(#flow-arrow)"
              />
            ))}
            {contextCards.map((card, i) => {
              const cx = NODE.pad + i * (contextWidth + 12) + contextWidth / 2;
              return (
                <path
                  key={card.label}
                  d={`M${cx},${CONTEXT_TOP + CONTEXT_H} L${cx},${BUS_Y}`}
                  fill="none"
                  stroke="var(--color-neutral-500)"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                />
              );
            })}
            <path
              d={`M${busLeft},${BUS_Y} L${busRight},${BUS_Y}`}
              fill="none"
              stroke="var(--color-neutral-500)"
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
          </svg>
          {contextCards.map((card, i) => (
            <button
              key={card.label}
              type="button"
              aria-label={card.label}
              onClick={() => props.onSelect(card.sel)}
              style={{
                left: NODE.pad + i * (contextWidth + 12),
                top: CONTEXT_TOP,
                width: contextWidth,
                height: CONTEXT_H,
              }}
              className={`${CARD} cursor-pointer gap-0.5 py-2 ${same(sel, card.sel) ? picked : idle}`}
            >
              <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-accent-700 uppercase">
                {card.label}
                {readOnly && <Lock />}
                <span className="ml-auto font-mono tracking-normal">{card.meta}</span>
              </span>
              <span className="line-clamp-2 text-xs text-neutral-700">{card.text}</span>
            </button>
          ))}
          <span
            className="absolute text-xs whitespace-nowrap text-neutral-700"
            style={{ left: busLeft, top: BUS_Y + 3 }}
          >
            applies to every turn
          </span>
          {nodes.map(render)}
          {!readOnly &&
            !empty &&
            !full &&
            edges.map((edge) => (
              <button
                key={`plus-${edge.at}`}
                type="button"
                data-slot
                aria-label="Add a step here"
                title="Add a step here"
                onClick={() => setAdding(adding === edge.at ? null : edge.at)}
                style={{ left: edge.x - 11, top: edge.y - 11 }}
                className={`absolute flex size-5.5 cursor-pointer items-center justify-center rounded-full border bg-card p-0 text-sm leading-none font-semibold text-accent shadow-sm hover:border-accent hover:bg-accent-100 ${
                  hot === edge.at ? 'border-accent bg-accent-100 ring-4 ring-accent-100' : 'border-divider'
                }`}
              >
                +
              </button>
            ))}
          {menuAt && !readOnly && (
            <div
              data-block-menu
              role="menu"
              aria-label="Step blocks"
              style={{
                left: Math.max(8, Math.min(menuAt.x - 170, canvasWidth - 356)),
                top: menuAt.y + 16,
              }}
              className="absolute z-20 flex max-h-80 w-85 flex-col gap-0.5 overflow-y-auto rounded-lg border border-line bg-card p-1.5 shadow-lg"
            >
              {props.blocks.map((block) => (
                <button
                  key={block.block}
                  type="button"
                  role="menuitem"
                  onClick={() => insert(block, menuAt.at)}
                  className="flex cursor-pointer flex-col gap-0.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left hover:bg-neutral-200"
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                    {block.title}
                    {block.writes && <ScratchTag />}
                  </span>
                  <span className="line-clamp-2 text-xs text-neutral-700">
                    {block.instructions || 'An empty step to write yourself.'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      <div className="flex flex-none flex-wrap items-center gap-4 border-t border-line bg-card px-4 py-2 text-xs text-neutral-700">
        <span className="flex items-center gap-1.5">
          <i className="inline-block w-5 border-t-[1.5px] border-neutral-500" />
          Run order
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block w-5 border-t-[1.5px] border-dashed border-neutral-500" />
          Applies to every turn
        </span>
        <span>A failed step stops the run: Retry or Skip it from the run.</span>
      </div>
    </div>
  );
}
