import { Inject, Injectable } from '@nestjs/common';
import {
  type AgentRun,
  ErrorCode,
  type RunDetail,
  RunHealth,
  type Subagent,
  subagentSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import {
  activityOf,
  classifyFailure,
  diagnoseSlow,
  healthOf,
  historyOf,
  openStep,
  type StepFacts,
  splitTime,
  stagesOf,
} from './run-insight';
import { factsOf, RunStepsLog } from './run-steps';
import { RunRegistry } from './runs';
import { SessionKinds } from './session-kinds';
import type { SessionRow } from './sessions.service';
import { SessionsService } from './sessions.service';

/** Steps of one run the detail returns: more than a run makes in a day of work. */
const MAX_STEPS = 500;

/** Reads the Running tray and the Agent runs page: each run's health, activity, cost and, on request, its steps. */
@Injectable()
export class RunInsights {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(RunRegistry) private readonly runs: RunRegistry,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
    @Inject(RunStepsLog) private readonly log: RunStepsLog,
  ) {}

  /** Every run going, then every run that ended unfinished and was not dismissed. */
  list(): AgentRun[] {
    const rows = this.sessions.runRows();
    const steps = this.log.stepsOf(rows.map((row) => row.id));
    const usage = this.log.usageOf(rows.map((row) => row.id));
    const history = historyOf(this.log.history());
    const now = Date.now();
    return rows.map((row) =>
      this.build(
        row,
        steps.filter((step) => step.sessionId === row.id && step.runStartedAt === row.runStartedAt).map(factsOf),
        usage.find((entry) => entry.sessionId === row.id && entry.runStartedAt === row.runStartedAt) ?? null,
        history,
        now,
      ),
    );
  }

  /** One run with its steps, where the time went, and why it is slow or failed. */
  detail(id: string): RunDetail {
    const row = this.sessions.get(id);
    if (row.runStartedAt === null) throw new ApiError(404, ErrorCode.NotFound, 'the session has no run yet');
    const facts = this.log
      .stepsOf([id])
      .filter((step) => step.runStartedAt === row.runStartedAt)
      .map(factsOf);
    const usage = this.log.usageOf([id]).find((entry) => entry.runStartedAt === row.runStartedAt) ?? null;
    const history = historyOf(this.log.history().filter((step) => !facts.some((own) => own.id === step.id)));
    const now = Date.now();
    const run = this.build(row, facts, usage, history, now);
    return {
      run,
      steps: facts.slice(-MAX_STEPS).map((step) => ({
        id: step.id,
        agent_id: step.agentId,
        tool: step.tool,
        summary: step.summary,
        phase: step.phase,
        started_at: new Date(step.startedAt).toISOString(),
        finished_at: step.finishedAt === null ? null : new Date(step.finishedAt).toISOString(),
        ok: step.ok,
        error: step.error,
      })),
      stages: stagesOf(facts, run.running),
      slow:
        run.health === RunHealth.Slow
          ? diagnoseSlow({ steps: facts, history, now, queued: row.queuedText !== null })
          : null,
      failure: run.running
        ? null
        : classifyFailure({ outcome: row.runOutcome, lastError: this.sessions.view(row).last_error, steps: facts }),
    };
  }

  /** What runs that ended today cost, from midnight of the machine's day. */
  usageToday(): { cost_usd: number; tokens: number; runs: number } {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const total = this.log.usageSince(midnight.toISOString());
    return { cost_usd: total.costUsd, tokens: total.tokens, runs: total.runs };
  }

  private build(
    row: SessionRow,
    steps: StepFacts[],
    usage: { costUsd: number; tokens: number } | null,
    history: ReturnType<typeof historyOf>,
    now: number,
  ): AgentRun {
    const run = this.runs.get(row.id);
    const running = run !== undefined;
    const session = this.sessions.view(row);
    const waiting = run?.waitingSince != null ? { since: run.waitingSince, on: waitingOn(run.parts, steps) } : null;
    const failure = running ? null : classifyFailure({ outcome: row.runOutcome, lastError: session.last_error, steps });
    const { health, reason } = healthOf({
      running,
      waiting,
      outcome: row.runOutcome,
      steps,
      history,
      now,
      failure,
    });
    const open = running ? openStep(steps) : null;
    return {
      session,
      running,
      outcome: row.runOutcome,
      started_at: row.runStartedAt,
      finished_at: row.runFinishedAt,
      can_resume: this.kinds.get(row.kind)?.acceptsMessages ?? false,
      can_retry: (this.kinds.get(row.kind)?.acceptsMessages ?? false) || this.kinds.retryOf(row.kind) !== undefined,
      subagents: subagentsOf(row),
      health,
      health_reason: reason,
      activity: open ? activityOf(open) : null,
      cost_usd: usage?.costUsd ?? null,
      tokens: usage?.tokens ?? null,
      split:
        row.runStartedAt === null
          ? []
          : splitTime(
              steps,
              Date.parse(row.runStartedAt),
              running || row.runFinishedAt === null ? now : Date.parse(row.runFinishedAt),
            ),
    };
  }
}

function subagentsOf(row: SessionRow): Subagent[] {
  return row.runSubagents === null ? [] : z.array(subagentSchema).parse(JSON.parse(row.runSubagents));
}

/** What the run waits on: the agent's open question, or the call an Approval holds. */
function waitingOn(parts: { kind: string; text?: string }[], steps: StepFacts[]): string {
  const question = parts.findLast((part) => part.kind === 'question');
  if (question?.text) return `"${question.text}"`;
  const step = openStep(steps);
  return step ? activityOf(step) : '';
}
