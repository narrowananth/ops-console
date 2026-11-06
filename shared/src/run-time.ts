import { RunPhase, SubagentStatus } from './agents';

/**
 * Time accounting of one run, shared by the daemon and the page so a number is the same wherever it is printed. Every
 * millisecond of a lane belongs to exactly one phase: a gap between calls is thinking, a call is its own phase, and
 * where calls overlap the more telling phase wins.
 */

/** A tool call as time accounting reads it. Times are epoch milliseconds. */
export type TimedStep = {
  id: string;
  /** The subagent that made the call; null for the main agent. */
  agentId: string | null;
  tool: string;
  phase: RunPhase;
  startedAt: number;
  finishedAt: number | null;
  /** Milliseconds of the call spent waiting on the operator. */
  waitedMs: number;
  ok: boolean | null;
  summary: string;
  error: string | null;
};

export type TimedSubagent = {
  id: string;
  parentId: string | null;
  description: string;
  type: string | null;
  status: SubagentStatus;
  startedAt: number;
  endedAt: number | null;
};

/** A stretch of one lane in one phase. `stepId` names the call it is, null for thinking and for waiting on the limit. */
export type Segment = { phase: RunPhase; start: number; end: number; stepId: string | null };

/** The legend's order. */
export const PHASE_ORDER: RunPhase[] = [
  RunPhase.Thinking,
  RunPhase.Reading,
  RunPhase.Editing,
  RunPhase.Commands,
  RunPhase.Subagents,
  RunPhase.WaitingYou,
  RunPhase.WaitingLimit,
];

/** Which phase wins where two overlap: a limit beats everything, thinking only fills what nothing else covers. */
const PRIORITY: Record<RunPhase, number> = {
  [RunPhase.Thinking]: 0,
  [RunPhase.Reading]: 1,
  [RunPhase.Editing]: 2,
  [RunPhase.Commands]: 3,
  [RunPhase.Subagents]: 4,
  [RunPhase.WaitingYou]: 5,
  [RunPhase.WaitingLimit]: 6,
};

/** The tools that start a subagent: the main agent is blocked on them. */
export const isSubagentCall = (tool: string) => tool === 'Agent' || tool === 'Task';

type Interval = { phase: RunPhase; start: number; end: number; stepId: string | null };

/** The intervals a call fills: its phase, and the part it waited on the operator. */
function intervalsOf(step: TimedStep, now: number): Interval[] {
  const end = Math.max(step.startedAt, step.finishedAt ?? now);
  const waited = Math.min(Math.max(0, step.waitedMs), end - step.startedAt);
  const phase = isSubagentCall(step.tool) ? RunPhase.Subagents : step.phase;
  const out: Interval[] = [{ phase, start: step.startedAt, end: end - waited, stepId: step.id }];
  if (waited > 0) out.push({ phase: RunPhase.WaitingYou, start: end - waited, end, stepId: step.id });
  return out;
}

/**
 * Cuts [start, end] into stretches, each in the phase of the strongest interval over it, thinking where none is. The
 * stretches follow one another with no gap and no overlap, so their lengths add up to `end - start`.
 */
export function partition(intervals: Interval[], start: number, end: number): Segment[] {
  if (end <= start) return [];
  const clipped = intervals
    .map((one) => ({ ...one, start: Math.max(start, one.start), end: Math.min(end, one.end) }))
    .filter((one) => one.end > one.start);
  const cuts = [...new Set([start, end, ...clipped.flatMap((one) => [one.start, one.end])])].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let index = 0; index < cuts.length - 1; index++) {
    const from = cuts[index] as number;
    const to = cuts[index + 1] as number;
    let top: Interval | null = null;
    for (const one of clipped) {
      if (one.start <= from && one.end >= to && (top === null || PRIORITY[one.phase] > PRIORITY[top.phase])) top = one;
    }
    const segment: Segment = top
      ? { phase: top.phase, start: from, end: to, stepId: top.stepId }
      : { phase: RunPhase.Thinking, start: from, end: to, stepId: null };
    const last = out.at(-1);
    // Pieces of one call, or of one stretch of thinking, are one segment.
    if (last && last.phase === segment.phase && last.stepId === segment.stepId && last.end === segment.start) {
      last.end = segment.end;
    } else {
      out.push(segment);
    }
  }
  return out;
}

/** One lane of the timeline: the main agent (`id` null) or one subagent. */
export type Lane = {
  id: string | null;
  parentId: string | null;
  depth: number;
  label: string;
  type: string | null;
  status: SubagentStatus | 'main';
  start: number;
  end: number;
  segments: Segment[];
  /** Milliseconds per phase, in `PHASE_ORDER`; adds up to `end - start`. */
  split: { phase: RunPhase; ms: number }[];
  /** The first call of the lane that failed. */
  failed: TimedStep | null;
  steps: number;
};

export function splitOf(segments: Segment[]): { phase: RunPhase; ms: number }[] {
  const ms = new Map<RunPhase, number>(PHASE_ORDER.map((phase) => [phase, 0]));
  for (const segment of segments) ms.set(segment.phase, (ms.get(segment.phase) ?? 0) + segment.end - segment.start);
  return PHASE_ORDER.map((phase) => ({ phase, ms: Math.round(ms.get(phase) ?? 0) }));
}

export type LanesInput = {
  steps: TimedStep[];
  subagents: TimedSubagent[];
  /** When the run began, and when it ended; null while it goes, which counts to `now`. */
  runStart: number;
  runEnd: number | null;
  now: number;
  /** When the run began to wait on the account's usage limit; the wait lasts to the run's end. */
  limitSince?: number | null;
};

/**
 * The lanes of a run. The main agent's lane covers the whole run; each subagent's covers its own life, and the main
 * lane shows the time it is blocked on a subagent call as `Subagents`, so no time is counted twice.
 */
export function lanesOf(input: LanesInput): Lane[] {
  const { steps, subagents, runStart, now } = input;
  const runEnd = input.runEnd ?? now;
  const byId = new Map(subagents.map((one) => [one.id, one]));
  const depthOf = (one: TimedSubagent): number => {
    let depth = 1;
    let parent = one.parentId === null ? undefined : byId.get(one.parentId);
    while (parent && depth < 12) {
      depth++;
      parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
    }
    return depth;
  };
  const make = (
    id: string | null,
    window: [number, number],
    extra: Interval[],
    meta: Pick<Lane, 'parentId' | 'depth' | 'label' | 'type' | 'status'>,
  ): Lane => {
    const mine = steps.filter((step) => step.agentId === id);
    const segments = partition([...mine.flatMap((step) => intervalsOf(step, now)), ...extra], window[0], window[1]);
    return {
      id,
      ...meta,
      start: window[0],
      end: window[1],
      segments,
      split: splitOf(segments),
      failed: mine.find((step) => step.ok === false) ?? null,
      steps: mine.length,
    };
  };
  const limit: Interval[] =
    input.limitSince != null && input.limitSince < runEnd
      ? [{ phase: RunPhase.WaitingLimit, start: input.limitSince, end: runEnd, stepId: null }]
      : [];
  const lanes: Lane[] = [
    make(null, [runStart, runEnd], limit, {
      parentId: null,
      depth: 0,
      label: 'Main agent',
      type: 'main',
      status: 'main',
    }),
  ];
  const ordered = [...subagents].sort((a, b) => a.startedAt - b.startedAt);
  const emit = (parent: string | null, seen: Set<string>) => {
    for (const one of ordered.filter((sub) => sub.parentId === parent && !seen.has(sub.id))) {
      seen.add(one.id);
      const end = one.endedAt ?? (input.runEnd === null ? now : runEnd);
      lanes.push(
        make(one.id, [one.startedAt, Math.max(one.startedAt, end)], [], {
          parentId: one.parentId,
          depth: depthOf(one),
          label: one.description,
          type: one.type,
          status: one.status,
        }),
      );
      emit(one.id, seen);
    }
  };
  const seen = new Set<string>();
  emit(null, seen);
  // A subagent whose parent is not known still gets a lane.
  for (const one of ordered) if (!seen.has(one.id)) emit(one.parentId, seen);
  return lanes;
}

/** Whole numbers for `values` that add up to 100, by largest remainder; all zero when `values` add up to zero. */
export function percentages(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index] = (floors[index] as number) + 1;
    left--;
  }
  return floors;
}

/** What each phase reads as in the headline: "93% in thinking". */
const HEADLINE_NAME: Record<RunPhase, string> = {
  [RunPhase.Thinking]: 'thinking',
  [RunPhase.Reading]: 'reading',
  [RunPhase.Editing]: 'editing',
  [RunPhase.Commands]: 'commands and tools',
  [RunPhase.Subagents]: 'subagents',
  [RunPhase.WaitingYou]: 'waiting on you',
  [RunPhase.WaitingLimit]: 'waiting on the usage limit',
};

/**
 * The one line over the breakdown, from unrounded milliseconds: one step that took over half the run, else the largest
 * phase. Null when the run has no time yet.
 */
export function headlineOf(input: {
  split: { phase: RunPhase; ms: number }[];
  /** The longest single step of the main agent, in milliseconds. */
  longestStepMs: number;
  subagentCount: number;
}): string | null {
  const total = input.split.reduce((sum, part) => sum + part.ms, 0);
  if (total <= 0) return null;
  const pct = percentages(input.split.map((part) => part.ms));
  const top = input.split.reduce((best, part, index) => (part.ms > (input.split[best]?.ms ?? -1) ? index : best), 0);
  const phase = input.split[top]?.phase ?? RunPhase.Thinking;
  if (input.longestStepMs / total > 0.5 && phase !== RunPhase.Subagents && phase !== RunPhase.WaitingLimit) {
    return `${Math.round((input.longestStepMs / total) * 100)}% in one command`;
  }
  if (phase === RunPhase.Subagents) {
    return `${pct[top]}% waiting on ${input.subagentCount} ${input.subagentCount === 1 ? 'subagent' : 'subagents'}`;
  }
  return `${pct[top]}% ${phase === RunPhase.WaitingYou || phase === RunPhase.WaitingLimit ? '' : 'in '}${HEADLINE_NAME[phase]}`;
}

/** Tick spacings the axis picks from, in milliseconds. */
export const TICK_STEPS_MS = [5e3, 10e3, 30e3, 60e3, 120e3, 300e3, 900e3, 3600e3];

/** The smallest spacing that keeps the axis to `maxTicks` labels or fewer. */
export function tickStep(spanMs: number, maxTicks = 6): number {
  const last = TICK_STEPS_MS.at(-1) as number;
  return TICK_STEPS_MS.find((step) => spanMs / step <= maxTicks) ?? last;
}

/** Ticks inside [start, end] at multiples of the step; labels show seconds under a minute, and are never repeated. */
export function ticksOf(
  start: number,
  end: number,
  label: (at: number, seconds: boolean) => string,
  maxTicks = 6,
): { at: number; label: string }[] {
  const step = tickStep(end - start, maxTicks);
  const seconds = step < 60_000;
  const out: { at: number; label: string }[] = [];
  const seen = new Set<string>();
  for (let at = Math.ceil(start / step) * step; at <= end; at += step) {
    const text = label(at, seconds);
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ at, label: text });
  }
  return out;
}

/**
 * Joins what would be unreadable: a stretch shorter than `minMs` that sits between two of the same phase joins them,
 * and neighbours of one phase become one span. The result still covers the lane without a gap.
 */
export function mergeSegments(segments: Segment[], minMs: number): Segment[] {
  const out: Segment[] = [];
  for (let index = 0; index < segments.length; index++) {
    const now = { ...(segments[index] as Segment) };
    const next = segments[index + 1];
    const last = out.at(-1);
    if (last && now.end - now.start < minMs && next && next.phase === last.phase) {
      last.end = now.end;
      last.stepId = null;
      continue;
    }
    if (last && last.phase === now.phase) {
      last.end = now.end;
      if (last.stepId !== now.stepId) last.stepId = null;
      continue;
    }
    out.push(now);
  }
  return out;
}

/** A stretch with no call in any lane, long enough to fold into one marker. */
export type IdleGap = { start: number; end: number };

/**
 * Stretches of [start, end] where no lane has a call (only thinking, or nothing) that are longer than `fraction` of
 * the whole span: the timeline folds each into a marker the operator can open.
 */
export function idleGaps(lanes: Lane[], start: number, end: number, fraction = 0.2): IdleGap[] {
  const span = end - start;
  if (span <= 0) return [];
  const busy = lanes
    .flatMap((lane) => lane.segments)
    .filter((segment) => segment.phase !== RunPhase.Thinking)
    .map((segment) => [Math.max(start, segment.start), Math.min(end, segment.end)] as const)
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  const gaps: IdleGap[] = [];
  let cursor = start;
  for (const [from, to] of busy) {
    if (from > cursor && from - cursor > span * fraction) gaps.push({ start: cursor, end: from });
    cursor = Math.max(cursor, to);
  }
  if (end > cursor && end - cursor > span * fraction) gaps.push({ start: cursor, end });
  return gaps;
}

/** Share of the width a folded gap takes. */
const GAP_SHARE = 0.04;

/** Maps a time to a fraction of the lane's width, with the folded gaps shrunk to a marker each. */
export function scaleOf(start: number, end: number, folded: IdleGap[]): (at: number) => number {
  const gaps = [...folded].sort((a, b) => a.start - b.start);
  const hidden = gaps.reduce((sum, gap) => sum + gap.end - gap.start, 0);
  const visible = Math.max(1, end - start - hidden);
  const room = Math.max(0.2, 1 - gaps.length * GAP_SHARE);
  return (at: number) => {
    const t = Math.min(end, Math.max(start, at));
    let before = 0;
    let marks = 0;
    for (const gap of gaps) {
      if (t >= gap.end) {
        before += gap.end - gap.start;
        marks++;
      } else if (t > gap.start) {
        return (
          ((gap.start - start - before) / visible) * room +
          marks * GAP_SHARE +
          ((t - gap.start) / (gap.end - gap.start)) * GAP_SHARE
        );
      }
    }
    return ((t - start - before) / visible) * room + marks * GAP_SHARE;
  };
}
