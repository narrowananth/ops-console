import { Inject, Injectable } from '@nestjs/common';
import {
  type AgentRun,
  ErrorCode,
  type RunDetail,
  RunHealth,
  type RunLimit,
  RunOutcome,
  type Subagent,
  subagentSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { NetworkAllowlistService } from '../network/network-allowlist.service';
import {
  activityOf,
  classifyFailure,
  diagnoseSlow,
  healthOf,
  historyOf,
  openStep,
  phasesOf,
  type StepFacts,
  splitTime,
} from './run-insight';
import { factsOf, RunStepsLog, type UsageRow } from './run-steps';
import { costAndTokens, runUsageOf, totalOf } from './run-usage';
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
    @Inject(NetworkAllowlistService) private readonly allowlist: NetworkAllowlistService,
  ) {}

  /** The hosts the Run sandbox refused this run that a run started now would still be refused. */
  private blockedOf(row: SessionRow): string[] {
    if (row.runBlockedHosts === null) return [];
    return z
      .array(z.string())
      .parse(JSON.parse(row.runBlockedHosts))
      .filter((host) => !this.allowlist.covers(host));
  }

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
        waited_ms: Math.round(step.waitedMs),
        ok: step.ok,
        error: step.error,
      })),
      stages: phasesOf({
        steps: facts,
        kind: row.kind,
        running: run.running,
        outcome: row.runOutcome,
        subagents: run.subagents.length,
      }),
      slow:
        run.health === RunHealth.Slow
          ? diagnoseSlow({ steps: facts, history, now, queued: row.queuedText !== null })
          : null,
      failure: run.running
        ? null
        : classifyFailure({
            outcome: row.runOutcome,
            lastError: this.sessions.view(row).last_error,
            steps: facts,
            subagents: run.subagents,
            resetsAt: row.runLimitResetsAt,
          }),
    };
  }

  /** What runs that ended today cost, from midnight of the machine's day. */
  usageToday(): { cost_usd: number; tokens: number; runs: number } {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return totalOf(this.log.usageRowsSince(midnight.toISOString()));
  }

  private build(
    row: SessionRow,
    steps: StepFacts[],
    usage: UsageRow | null,
    history: ReturnType<typeof historyOf>,
    now: number,
  ): AgentRun {
    const run = this.runs.get(row.id);
    const running = run !== undefined;
    const session = this.sessions.view(row);
    const waiting = run?.waitingSince != null ? { since: run.waitingSince, on: waitingOn(run.parts, steps) } : null;
    const subagents = subagentsOf(row);
    const failure = running
      ? null
      : classifyFailure({
          outcome: row.runOutcome,
          lastError: session.last_error,
          steps,
          subagents,
          resetsAt: row.runLimitResetsAt,
        });
    const { health, reason } = healthOf({
      running,
      waiting,
      outcome: row.runOutcome,
      steps,
      history,
      now,
      failure,
      blocked: this.blockedOf(row),
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
      subagents,
      health,
      health_reason: reason,
      activity: open ? activityOf(open) : null,
      cost_usd: usage ? costAndTokens(usage).cost_usd : null,
      tokens: usage ? costAndTokens(usage).tokens : null,
      usage: usage ? runUsageOf(usage) : null,
      limit: limitOf(row),
      blocked_hosts: this.blockedOf(row),
      split:
        row.runStartedAt === null
          ? []
          : splitTime({
              steps,
              startedAt: Date.parse(row.runStartedAt),
              endedAt: running || row.runFinishedAt === null ? null : Date.parse(row.runFinishedAt),
              now,
              limitSince: row.runLimitSince === null ? null : Date.parse(row.runLimitSince),
            }),
    };
  }
}

/** The usage limit a run waits on or ended on. */
function limitOf(row: SessionRow): RunLimit | null {
  if (row.runLimitSince === null && row.runOutcome !== RunOutcome.RateLimited) return null;
  return { since: row.runLimitSince, resets_at: row.runLimitResetsAt };
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
