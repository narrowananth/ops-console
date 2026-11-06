import {
  type AgentRun,
  idleGaps,
  type Lane,
  mergeSegments,
  RunPhase,
  type RunStep,
  type Segment,
  SubagentStatus,
  scaleOf,
  ticksOf,
} from '@ops-console/shared';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { StatusIcon } from './run-breakdown';
import { clock as clockOf, clockSeconds, legendMs, PHASE } from './run-look';
import type { RunClock } from './run-model';
import { Heading, plural, shown } from './run-parts';

/** Subagent lanes the timeline draws before "Show more". */
const LANES_SHOWN = 8;
const ROW = 22;
const MIN_PX = 2;
const MERGE_PX = 3;

type View = { kind: 'fit' } | { kind: 'last'; ms: number } | { kind: 'range'; start: number; end: number };
type LaneFilter = 'all' | 'failed' | 'running';

/** The parts of [from, to] that no folded gap covers. */
function outsideGaps(from: number, to: number, gaps: { start: number; end: number }[]): [number, number][] {
  let out: [number, number][] = [[from, to]];
  for (const gap of gaps) {
    out = out.flatMap(([a, b]): [number, number][] =>
      b <= gap.start || a >= gap.end
        ? [[a, b]]
        : (
            [
              [a, Math.min(b, gap.start)],
              [Math.max(a, gap.end), b],
            ] as [number, number][]
          ).filter(([x, y]) => y > x),
    );
  }
  return out;
}

const hatch = (color: string) => `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 7px)`;

/**
 * One lane per agent: the main agent and each subagent, with every stretch of its time in its phase's colour, thinking
 * included. Widths are time. A stretch of no activity in any lane folds into one marker; the axis, zoom and the lane
 * filter keep a run of many subagents readable.
 */
export function Timeline({
  run,
  clock,
  steps,
  onJump,
}: {
  run: AgentRun;
  clock: RunClock;
  steps: RunStep[];
  onJump: (stepId: string) => void;
}) {
  const [view, setView] = useState<View>({ kind: 'fit' });
  const [open, setOpen] = useState<number[]>([]);
  const [filter, setFilter] = useState<LaneFilter>('all');
  const [more, setMore] = useState(false);
  const [labelW, setLabelW] = useState(240);
  const [width, setWidth] = useState(800);
  const [selection, setSelection] = useState<{ a: number; b: number } | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);

  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const watch = new ResizeObserver(() => setWidth(node.clientWidth));
    setWidth(node.clientWidth);
    watch.observe(node);
    return () => watch.disconnect();
  }, []);

  const { start, end } = clock;
  const winStart =
    view.kind === 'range' ? Math.max(start, view.start) : view.kind === 'last' ? Math.max(start, end - view.ms) : start;
  const winEnd = view.kind === 'range' ? Math.min(end, view.end) : end;
  const span = Math.max(1, winEnd - winStart);

  const gaps = useMemo(
    () =>
      idleGaps(clock.lanes, winStart, winEnd).filter(
        // The stretch since the last call of a run still going is not idle yet.
        (gap) => !(run.running && gap.end >= winEnd),
      ),
    [clock.lanes, winStart, winEnd, run.running],
  );
  const folded = gaps.filter((gap) => !open.includes(gap.start));
  const at = scaleOf(winStart, winEnd, folded);
  const pct = (t: number) => at(t) * 100;
  const hidden = folded.reduce((sum, gap) => sum + gap.end - gap.start, 0);
  const msPerPx = Math.max(1, span - hidden) / Math.max(1, width * (1 - folded.length * 0.04));
  const stepOf = useMemo(() => new Map(steps.map((step) => [step.id, step])), [steps]);

  const subs = clock.lanes.slice(1);
  const counted = (status: SubagentStatus) => subs.filter((lane) => lane.status === status).length;
  const failed = counted(SubagentStatus.Failed);
  const working = counted(SubagentStatus.Working);
  const stopped = counted(SubagentStatus.Stopped);
  const done = counted(SubagentStatus.Done);
  const pickable = subs.filter((lane) =>
    filter === 'failed'
      ? lane.status === SubagentStatus.Failed
      : filter === 'running'
        ? lane.status === SubagentStatus.Working
        : true,
  );
  const drawn = more ? pickable : pickable.slice(0, LANES_SHOWN);
  const lanes: Lane[] = [...(clock.main ? [clock.main] : []), ...drawn];

  const ticks = ticksOf(
    winStart,
    winEnd,
    (t, seconds) => (seconds ? clockSeconds(t) : clockOf(t)),
    Math.max(3, Math.min(10, Math.floor(width / 120))),
  ).filter((tick) => !folded.some((gap) => tick.at > gap.start && tick.at < gap.end));

  const timeAt = (frac: number) => {
    let low = winStart;
    let high = winEnd;
    for (let index = 0; index < 32; index++) {
      const mid = (low + high) / 2;
      if (at(mid) < frac) low = mid;
      else high = mid;
    }
    return (low + high) / 2;
  };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !track.current) return;
    const box = track.current.getBoundingClientRect();
    const from = event.clientX - box.left;
    let moved = false;
    const move = (next: PointerEvent) => {
      const x = Math.min(box.width, Math.max(0, next.clientX - box.left));
      if (Math.abs(x - from) > 6) moved = true;
      if (moved) setSelection({ a: from, b: x });
    };
    const up = (next: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSelection(null);
      if (!moved) return;
      dragged.current = true;
      setTimeout(() => {
        dragged.current = false;
      }, 0);
      const x = Math.min(box.width, Math.max(0, next.clientX - box.left));
      const [a, b] = [from, x].sort((p, q) => p - q) as [number, number];
      if (b - a > 8) setView({ kind: 'range', start: timeAt(a / box.width), end: timeAt(b / box.width) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = event.clientX;
    const base = labelW;
    const move = (next: PointerEvent) => setLabelW(Math.min(420, Math.max(140, base + next.clientX - from)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const label = (segment: Segment, lane: Lane) => {
    const length = legendMs(segment.end - segment.start);
    const step = segment.stepId === null ? undefined : stepOf.get(segment.stepId);
    if (step) {
      return `${shown(step.summary)} · starts ${clockSeconds(segment.start)} · ${length}${step.ok === false ? ` · failed${step.error ? `: ${step.error}` : ''}` : ''}`;
    }
    const name =
      segment.phase === RunPhase.Thinking
        ? 'Thinking'
        : segment.phase === RunPhase.Subagents
          ? lane.id === null
            ? 'Waiting on subagents'
            : 'Waiting on its subagents'
          : segment.phase === RunPhase.WaitingLimit
            ? 'Waiting on the usage limit'
            : PHASE[segment.phase].label;
    return `${name} · starts ${clockSeconds(segment.start)} · ${length}`;
  };

  const zoomButton = (text: string, active: boolean, onClick: () => void, title: string) => (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] ${
        active ? 'border-text bg-text text-card' : 'border-divider bg-card text-neutral-800 hover:bg-neutral-200'
      }`}
    >
      {text}
    </button>
  );
  const tabs: [LaneFilter, string][] = [
    ['all', 'All'],
    ['failed', 'Failed'],
    ['running', 'Running'],
  ];

  return (
    <section className="mb-5">
      <Heading note="main agent and subagents">Timeline</Heading>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-neutral-800">
        {subs.length > 0 && (
          <span className="font-mono">
            {plural(subs.length, 'subagent')} · {done} done
            {working > 0 ? ` · ${working} working` : ''}
            {stopped > 0 ? ` · ${stopped} stopped` : ''}
            {failed > 0 ? ` · ${failed} failed` : ''}
          </span>
        )}
        <span className="flex-1" />
        {subs.length > 0 && (
          <span role="tablist" aria-label="Show lanes" className="flex gap-1">
            {tabs.map(([id, text]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                onClick={() => setFilter(id)}
                className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] ${
                  filter === id ? 'border-text bg-text text-card' : 'border-divider bg-card hover:bg-neutral-200'
                }`}
              >
                {text}
              </button>
            ))}
          </span>
        )}
        <fieldset aria-label="Zoom" className="m-0 flex items-center gap-1 border-0 p-0">
          {zoomButton('Fit', view.kind === 'fit', () => setView({ kind: 'fit' }), 'The whole run')}
          {zoomButton(
            '1m',
            view.kind === 'last' && view.ms === 60_000,
            () => setView({ kind: 'last', ms: 60_000 }),
            'The last minute',
          )}
          {zoomButton(
            '5m',
            view.kind === 'last' && view.ms === 300_000,
            () => setView({ kind: 'last', ms: 300_000 }),
            'The last 5 minutes',
          )}
          {view.kind !== 'fit' && (
            <button
              type="button"
              onClick={() => setView({ kind: 'fit' })}
              className="cursor-pointer rounded-full border border-divider bg-card px-2.5 py-0.5 text-[11px] hover:bg-neutral-200"
            >
              Reset
            </button>
          )}
        </fieldset>
      </div>
      <div className="rounded-xl border border-line bg-card p-3">
        <div className="flex">
          <div className="flex-none" style={{ width: labelW }}>
            {lanes.map((lane) => (
              <div
                key={lane.id ?? 'main'}
                style={{ height: ROW, paddingLeft: lane.depth * 12 }}
                className={`flex items-center gap-1.5 pr-2 text-[11px] ${lane.id === null ? 'font-semibold' : 'text-neutral-800'}`}
              >
                <StatusIcon status={lane.status} running={run.running} />
                <span
                  className="truncate"
                  title={lane.type && lane.id !== null ? `${lane.label} (${lane.type})` : lane.label}
                >
                  {lane.label}
                </span>
              </div>
            ))}
            <div style={{ height: 20 }} />
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no native element */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the lane names"
            title="Drag to resize the names"
            onPointerDown={startResize}
            className="mx-1 w-1 flex-none cursor-col-resize rounded bg-transparent hover:bg-neutral-300"
          />
          <div
            className="min-w-0 flex-1 select-none"
            ref={track}
            onPointerDown={startDrag}
            title="Drag across the lanes to zoom in"
          >
            <div className="relative" style={{ height: lanes.length * ROW }}>
              <div aria-hidden className="pointer-events-none absolute inset-0">
                {ticks.map((tick) => (
                  <span
                    key={tick.at}
                    className="absolute inset-y-0 border-l border-line"
                    style={{ left: `${pct(tick.at)}%` }}
                  />
                ))}
                {run.running && winEnd >= end && (
                  <span className="absolute inset-y-0 right-0 border-l-2 border-dashed border-text/40" />
                )}
              </div>
              {lanes.map((lane, row) => {
                const clipped = lane.segments
                  .map((one) => ({ ...one, start: Math.max(one.start, winStart), end: Math.min(one.end, winEnd) }))
                  .filter((one) => one.end > one.start);
                const merged = mergeSegments(clipped, MERGE_PX * msPerPx);
                const marker = lane.failed;
                const markerAt = marker ? (marker.finishedAt ?? marker.startedAt) : null;
                return (
                  <div
                    key={lane.id ?? 'main'}
                    data-lane={lane.id ?? 'main'}
                    className="absolute right-0 left-0"
                    style={{ top: row * ROW, height: ROW }}
                  >
                    <div aria-hidden className="absolute inset-x-0 top-1 h-3.5 rounded-md bg-neutral-100" />
                    {merged.flatMap((segment) =>
                      outsideGaps(segment.start, segment.end, folded).map(([from, to]) => {
                        const color = PHASE[segment.phase].color;
                        const waiting = segment.phase === RunPhase.Subagents;
                        const shared = {
                          'data-phase': segment.phase,
                          title: label({ ...segment, start: from, end: to }, lane),
                          style: {
                            left: `${pct(from)}%`,
                            width: `max(${MIN_PX}px, ${pct(to) - pct(from)}%)`,
                            background: waiting ? hatch(color) : color,
                            boxShadow: waiting ? `inset 0 0 0 1px ${color}` : undefined,
                          },
                        };
                        const stepId = segment.stepId;
                        return stepId ? (
                          <button
                            type="button"
                            key={`${segment.phase}-${from}`}
                            {...shared}
                            onClick={() => !dragged.current && onJump(stepId)}
                            className="absolute top-1 h-3.5 cursor-pointer rounded-sm border-0 p-0"
                          />
                        ) : (
                          <span
                            key={`${segment.phase}-${from}`}
                            {...shared}
                            className="absolute top-1 h-3.5 rounded-sm"
                          />
                        );
                      }),
                    )}
                    {marker &&
                      markerAt !== null &&
                      markerAt >= winStart &&
                      markerAt <= winEnd &&
                      !folded.some((g) => markerAt > g.start && markerAt < g.end) && (
                        <button
                          type="button"
                          title={`${lane.label} failed: ${marker.error ?? 'a call failed'}`}
                          aria-label={`${lane.label} failed. Show the step`}
                          onClick={() => !dragged.current && onJump(marker.id)}
                          className="absolute top-0 z-10 flex size-5 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-accent p-0 text-[11px] font-bold text-white"
                          style={{ left: `${pct(markerAt)}%` }}
                        >
                          !
                        </button>
                      )}
                  </div>
                );
              })}
              {folded.map((gap) => (
                <button
                  key={gap.start}
                  type="button"
                  title={`Nothing happened for ${legendMs(gap.end - gap.start)}. Show it.`}
                  onClick={() => setOpen([...open, gap.start])}
                  className="absolute inset-y-0 z-10 flex cursor-pointer items-center justify-center rounded border border-dashed border-neutral-400 bg-card/90 p-0 font-mono text-[10px] text-neutral-800 [writing-mode:vertical-rl]"
                  style={{ left: `${pct(gap.start)}%`, width: '4%' }}
                >
                  ⋯ {legendMs(gap.end - gap.start)}
                </button>
              ))}
              {selection && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 z-20 rounded border border-info bg-info/15"
                  style={{ left: Math.min(selection.a, selection.b), width: Math.abs(selection.b - selection.a) }}
                />
              )}
            </div>
            <div className="relative h-5 font-mono text-[10px] text-neutral-700">
              {ticks.map((tick) => (
                <span
                  key={tick.at}
                  className="absolute top-1 -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${pct(tick.at)}%` }}
                >
                  {tick.label}
                </span>
              ))}
              {run.running && winEnd >= end && <span className="absolute top-1 right-0 bg-card pl-1">now</span>}
              {gaps
                .filter((gap) => open.includes(gap.start))
                .map((gap) => (
                  <button
                    key={gap.start}
                    type="button"
                    title="Fold this stretch again"
                    onClick={() => setOpen(open.filter((one) => one !== gap.start))}
                    className="absolute -top-px cursor-pointer rounded border border-dashed border-neutral-400 bg-card px-1 text-[10px]"
                    style={{ left: `${pct(gap.start)}%` }}
                  >
                    fold ⋯ {legendMs(gap.end - gap.start)}
                  </button>
                ))}
            </div>
          </div>
        </div>
        {pickable.length > LANES_SHOWN && (
          <button
            type="button"
            onClick={() => setMore(!more)}
            className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-700"
          >
            {more ? `Show the first ${LANES_SHOWN}` : `Show ${pickable.length - LANES_SHOWN} more`}
          </button>
        )}
        {pickable.length === 0 && subs.length > 0 && (
          <p className="m-0 mt-1 text-xs text-neutral-700">
            No subagent is {filter === 'failed' ? 'failed' : 'running'}.
          </p>
        )}
      </div>
    </section>
  );
}
