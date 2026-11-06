import {
  type AgentRun,
  type Lane,
  lanesOf,
  type RunStep,
  type Subagent,
  type TimedStep,
  type TimedSubagent,
} from '@ops-console/shared';
import { useMemo } from 'react';
import { useNow } from '../components/ui/elapsed';

const ms = (iso: string) => Date.parse(iso);

export const timedStepOf = (step: RunStep): TimedStep => ({
  id: step.id,
  agentId: step.agent_id,
  tool: step.tool,
  phase: step.phase,
  startedAt: ms(step.started_at),
  finishedAt: step.finished_at === null ? null : ms(step.finished_at),
  waitedMs: step.waited_ms,
  ok: step.ok,
  summary: step.summary,
  error: step.error,
});

const timedSubagentOf = (one: Subagent): TimedSubagent => ({
  id: one.id,
  parentId: one.parent_id,
  description: one.description,
  type: one.type,
  status: one.status,
  startedAt: ms(one.started_at),
  endedAt: one.finished_at === null ? null : ms(one.finished_at),
});

/** The run's time as the page reads it: every lane from the same steps and the same `now`. */
export type RunClock = {
  now: number;
  start: number;
  /** Where the run ends: the run's end, or `now` while it goes. */
  end: number;
  lanes: Lane[];
  /** The main agent's lane, whose phases add up to the run's elapsed time. */
  main: Lane | undefined;
  total: number;
  /** The main agent's longest single step. */
  longestStepMs: number;
};

/**
 * One clock for the header, the breakdown and the timeline: they take the same shared ticker and the same steps, so the
 * header's elapsed time, the bar's total and the timeline's right edge are one number.
 */
export function useRunClock(run: AgentRun, steps: RunStep[]): RunClock | null {
  const ticked = useNow(run.running);
  // A run that ended does not move: its clock stops at its end, so nothing below recomputes each second.
  const now = run.running || run.finished_at === null ? ticked : ms(run.finished_at);
  return useMemo(() => {
    if (run.started_at === null) return null;
    const start = ms(run.started_at);
    const live = run.running || run.finished_at === null;
    const end = now;
    const timed = steps.map(timedStepOf);
    const lanes = lanesOf({
      steps: timed,
      subagents: run.subagents.map(timedSubagentOf),
      runStart: start,
      runEnd: live ? null : end,
      now,
      limitSince: run.limit?.since ? ms(run.limit.since) : null,
    });
    const main = lanes[0];
    const longestStepMs = timed
      .filter((step) => step.agentId === null)
      .reduce((best, step) => Math.max(best, (step.finishedAt ?? now) - step.startedAt - step.waitedMs), 0);
    return {
      now,
      start,
      end,
      lanes,
      main,
      total: end - start,
      longestStepMs,
    };
  }, [run, steps, now]);
}
