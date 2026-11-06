import {
  headlineOf,
  idleGaps,
  lanesOf,
  mergeSegments,
  percentages,
  RunPhase,
  SubagentStatus,
  scaleOf,
  splitOf,
  type TimedStep,
  type TimedSubagent,
  tickStep,
  ticksOf,
} from '@ops-console/shared';
import { describe, expect, it } from 'vitest';

const S = 1000;
const step = (over: Partial<TimedStep> & { startedAt: number }): TimedStep => ({
  id: `s${over.startedAt}`,
  agentId: null,
  tool: 'Bash',
  phase: RunPhase.Commands,
  finishedAt: over.startedAt + S,
  waitedMs: 0,
  ok: true,
  summary: '$ ls',
  error: null,
  ...over,
});
const sub = (over: Partial<TimedSubagent> & { id: string; startedAt: number }): TimedSubagent => ({
  parentId: null,
  description: over.id,
  type: null,
  status: SubagentStatus.Done,
  endedAt: over.startedAt + 10 * S,
  ...over,
});
const ms = (split: { phase: RunPhase; ms: number }[], phase: RunPhase) => split.find((p) => p.phase === phase)?.ms;

describe('time accounting', () => {
  it('gives every millisecond of the main lane to one phase: gaps are thinking', () => {
    const [main] = lanesOf({
      steps: [
        step({ startedAt: 10 * S, finishedAt: 14 * S }),
        step({ startedAt: 20 * S, finishedAt: 25 * S, tool: 'Read', phase: RunPhase.Reading }),
      ],
      subagents: [],
      runStart: 0,
      runEnd: 30 * S,
      now: 99 * S,
    });
    expect(main?.split.reduce((sum, part) => sum + part.ms, 0)).toBe(30 * S);
    expect(ms(main?.split ?? [], RunPhase.Commands)).toBe(4 * S);
    expect(ms(main?.split ?? [], RunPhase.Reading)).toBe(5 * S);
    expect(ms(main?.split ?? [], RunPhase.Thinking)).toBe(21 * S);
  });

  it('counts overlapping calls once, and the running step to now', () => {
    const [main] = lanesOf({
      steps: [
        step({ startedAt: 0, finishedAt: 10 * S }),
        step({ startedAt: 5 * S, finishedAt: 8 * S, tool: 'Read', phase: RunPhase.Reading }),
        step({ startedAt: 12 * S, finishedAt: null }),
      ],
      subagents: [],
      runStart: 0,
      runEnd: null,
      now: 20 * S,
    });
    expect(main?.split.reduce((sum, part) => sum + part.ms, 0)).toBe(20 * S);
    expect(ms(main?.split ?? [], RunPhase.Commands)).toBe(10 * S + 8 * S);
    expect(ms(main?.split ?? [], RunPhase.Reading)).toBe(0);
  });

  it('calls the time the main agent is blocked on a Task call Subagents, and counts it once', () => {
    const lanes = lanesOf({
      steps: [
        step({ startedAt: 0, finishedAt: 20 * S, tool: 'Task', summary: 'Task Explore' }),
        step({ startedAt: 2 * S, finishedAt: 6 * S, agentId: 'a', tool: 'Read', phase: RunPhase.Reading }),
      ],
      subagents: [sub({ id: 'a', startedAt: S, endedAt: 19 * S })],
      runStart: 0,
      runEnd: 20 * S,
      now: 99 * S,
    });
    const [main, child] = lanes;
    expect(ms(main?.split ?? [], RunPhase.Subagents)).toBe(20 * S);
    expect(ms(main?.split ?? [], RunPhase.Reading)).toBe(0);
    expect(child?.split.reduce((sum, part) => sum + part.ms, 0)).toBe(18 * S);
    expect(ms(child?.split ?? [], RunPhase.Reading)).toBe(4 * S);
    expect(ms(child?.split ?? [], RunPhase.Thinking)).toBe(14 * S);
  });

  it('takes the part of a call spent waiting on the operator out of its own phase', () => {
    const [main] = lanesOf({
      steps: [step({ startedAt: 0, finishedAt: 10 * S, waitedMs: 6 * S })],
      subagents: [],
      runStart: 0,
      runEnd: 10 * S,
      now: 10 * S,
    });
    expect(ms(main?.split ?? [], RunPhase.WaitingYou)).toBe(6 * S);
    expect(ms(main?.split ?? [], RunPhase.Commands)).toBe(4 * S);
  });

  it('counts the time from the usage limit to the end as waiting on the limit', () => {
    const [main] = lanesOf({
      steps: [step({ startedAt: 0, finishedAt: 10 * S })],
      subagents: [],
      runStart: 0,
      runEnd: 30 * S,
      now: 30 * S,
      limitSince: 20 * S,
    });
    expect(ms(main?.split ?? [], RunPhase.WaitingLimit)).toBe(10 * S);
    expect(main?.split.reduce((sum, part) => sum + part.ms, 0)).toBe(30 * S);
  });

  it('nests a subagent of a subagent one level deeper', () => {
    const lanes = lanesOf({
      steps: [],
      subagents: [sub({ id: 'a', startedAt: 0 }), sub({ id: 'b', startedAt: S, parentId: 'a' })],
      runStart: 0,
      runEnd: 20 * S,
      now: 20 * S,
    });
    expect(lanes.map((lane) => [lane.id, lane.depth])).toEqual([
      [null, 0],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('makes percentages add up to 100 by largest remainder', () => {
    expect(percentages([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percentages([66, 33, 1])).toEqual([66, 33, 1]);
    expect(percentages([0, 0])).toEqual([0, 0]);
    for (const values of [
      [1, 2, 3, 4, 5, 6, 7],
      [333, 333, 334],
      [1, 999_999],
    ]) {
      expect(percentages(values).reduce((sum, value) => sum + value, 0)).toBe(100);
    }
  });

  it('names the largest phase, one long step, or the subagents in the headline', () => {
    const split = (thinking: number, commands: number, subagents = 0) => [
      { phase: RunPhase.Thinking, ms: thinking },
      { phase: RunPhase.Commands, ms: commands },
      { phase: RunPhase.Subagents, ms: subagents },
    ];
    expect(headlineOf({ split: split(93, 7), longestStepMs: 5, subagentCount: 0 })).toBe('93% in thinking');
    expect(headlineOf({ split: split(30, 70), longestStepMs: 66, subagentCount: 0 })).toBe('66% in one command');
    expect(headlineOf({ split: split(30, 8, 62), longestStepMs: 5, subagentCount: 12 })).toBe(
      '62% waiting on 12 subagents',
    );
    expect(headlineOf({ split: split(0, 0), longestStepMs: 0, subagentCount: 0 })).toBeNull();
  });

  it('splits segments back into the lane total', () => {
    expect(
      splitOf([
        { phase: RunPhase.Thinking, start: 0, end: 4, stepId: null },
        { phase: RunPhase.Commands, start: 4, end: 10, stepId: 'x' },
      ]).filter((part) => part.ms > 0),
    ).toEqual([
      { phase: RunPhase.Thinking, ms: 4 },
      { phase: RunPhase.Commands, ms: 6 },
    ]);
  });
});

describe('timeline helpers', () => {
  it('picks the smallest tick step that fits, and shows seconds under a minute', () => {
    expect(tickStep(25 * S)).toBe(5 * S);
    expect(tickStep(2 * 60 * S)).toBe(30 * S);
    expect(tickStep(5 * 60 * S)).toBe(60 * S);
    expect(tickStep(40 * 60 * S)).toBe(900 * S);
    expect(tickStep(99 * 3600 * S)).toBe(3600 * S);
  });

  it('never prints the same tick label twice', () => {
    const label = (at: number, seconds: boolean) => {
      const whole = Math.floor(at / S);
      const minute = `10:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}`;
      return seconds ? `${minute}:${String(whole % 60).padStart(2, '0')}` : minute;
    };
    const short = ticksOf(0, 28 * S, label);
    expect(short.map((tick) => tick.label)).toEqual([
      '10:00:00',
      '10:00:05',
      '10:00:10',
      '10:00:15',
      '10:00:20',
      '10:00:25',
    ]);
    for (const [from, to] of [
      [0, 3 * 60 * S],
      [0, 70 * 60 * S],
      [0, 20 * S],
    ] as const) {
      const labels = ticksOf(from, to, label).map((tick) => tick.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
    // Labels that do not show seconds collapse to one when the step is finer than they show.
    expect(new Set(ticksOf(0, 28 * S, () => '10:46').map((tick) => tick.label)).size).toBe(1);
  });

  it('merges a sliver between two stretches of one phase, and neighbours of one phase', () => {
    const seg = (phase: RunPhase, start: number, end: number) => ({ phase, start, end, stepId: `${start}` });
    const merged = mergeSegments(
      [
        seg(RunPhase.Commands, 0, 100),
        seg(RunPhase.Reading, 100, 101),
        seg(RunPhase.Commands, 101, 200),
        seg(RunPhase.Thinking, 200, 300),
      ],
      5,
    );
    expect(merged.map((one) => [one.phase, one.start, one.end])).toEqual([
      [RunPhase.Commands, 0, 200],
      [RunPhase.Thinking, 200, 300],
    ]);
  });

  it('folds a stretch with no call in any lane when it is over a fifth of the span', () => {
    const lanes = lanesOf({
      steps: [
        step({ startedAt: 0, finishedAt: 10 * S }),
        step({ startedAt: 90 * S, finishedAt: 100 * S, agentId: 'a' }),
        step({ startedAt: 105 * S, finishedAt: 110 * S }),
      ],
      subagents: [sub({ id: 'a', startedAt: 85 * S, endedAt: 110 * S })],
      runStart: 0,
      runEnd: 110 * S,
      now: 110 * S,
    });
    expect(idleGaps(lanes, 0, 110 * S)).toEqual([{ start: 10 * S, end: 90 * S }]);
    expect(idleGaps(lanes, 0, 110 * S, 0.9)).toEqual([]);
  });

  it('shrinks a folded gap to a marker and keeps the rest in order', () => {
    const at = scaleOf(0, 100 * S, [{ start: 10 * S, end: 90 * S }]);
    expect(at(0)).toBe(0);
    expect(at(100 * S)).toBeCloseTo(1, 5);
    expect(at(10 * S)).toBeLessThan(at(50 * S));
    expect(at(50 * S)).toBeLessThan(at(90 * S));
    expect(at(90 * S) - at(10 * S)).toBeCloseTo(0.04, 5);
  });
});
