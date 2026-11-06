import { Inject, Injectable } from '@nestjs/common';
import { type RunPurpose, type Subagent, SubagentStatus } from '@ops-console/shared';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { redact } from '../action-log/redact';
import { runAgents, runSteps, runUsage } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { mergeLines, sumTokens, type UsageLine } from './pricing';
import { phaseOf, type StepFacts } from './run-insight';
import type { Run } from './runs';

/** Steps rows kept to say how long a command usually takes. */
const HISTORY_ROWS = 3000;

type StepRow = typeof runSteps.$inferSelect;
export type AgentRow = typeof runAgents.$inferSelect;

export function factsOf(row: StepRow): StepFacts {
  return {
    id: row.id,
    agentId: row.agentId,
    tool: row.tool,
    summary: row.summary,
    phase: row.phase,
    startedAt: Date.parse(row.startedAt),
    finishedAt: row.finishedAt === null ? null : Date.parse(row.finishedAt),
    waitedMs: row.waitedMs,
    ok: row.ok,
    error: row.error,
  };
}

/** Writes each tool call of a run as it starts and ends, so the Agent runs page can say where the time went. */
@Injectable()
export class RunStepsLog {
  constructor(@Inject(STORE) private readonly store: Store) {}

  /** A subagent starts (the run's `task_started`): kept past the run, with how it ends. */
  agentStarted(run: Run, agent: Subagent): void {
    this.store.write((tx) =>
      tx
        .insert(runAgents)
        .values({
          id: crypto.randomUUID(),
          sessionId: run.sessionId,
          runStartedAt: run.createdAt,
          taskId: agent.id,
          parentId: agent.parent_id,
          type: agent.type,
          description: redact(agent.description).slice(0, 200),
          status: SubagentStatus.Working,
          startedAt: agent.started_at,
        })
        .onConflictDoNothing()
        .run(),
    );
  }

  /** A subagent ends (`task_notification`). */
  agentEnded(run: Run, agent: Subagent): void {
    this.store.write((tx) =>
      tx
        .update(runAgents)
        .set({ status: agent.status, finishedAt: agent.finished_at ?? new Date().toISOString() })
        .where(
          and(
            eq(runAgents.sessionId, run.sessionId),
            eq(runAgents.runStartedAt, run.createdAt),
            eq(runAgents.taskId, agent.id),
          ),
        )
        .run(),
    );
  }

  /** A run ended with subagents still going: they stop with it. */
  closeOpenAgents(sessionId: string): void {
    this.store.write((tx) =>
      tx
        .update(runAgents)
        .set({ status: SubagentStatus.Stopped, finishedAt: new Date().toISOString() })
        .where(and(eq(runAgents.sessionId, sessionId), isNull(runAgents.finishedAt)))
        .run(),
    );
  }

  /** The daemon restarted: no subagent is going any more. */
  closeAllOpenAgents(): void {
    this.store.write((tx) =>
      tx
        .update(runAgents)
        .set({ status: SubagentStatus.Stopped, finishedAt: new Date().toISOString() })
        .where(isNull(runAgents.finishedAt))
        .run(),
    );
  }

  /** The subagents of every run that began since `since`, for account usage. */
  agentsSince(since: string): AgentRow[] {
    return this.store.db.select().from(runAgents).where(gte(runAgents.startedAt, since)).all();
  }

  start(run: Run, step: { id: string; agentId: string | null; tool: string; summary: string }): void {
    this.store.write((tx) =>
      tx
        .insert(runSteps)
        .values({
          id: step.id,
          sessionId: run.sessionId,
          runStartedAt: run.createdAt,
          agentId: step.agentId,
          tool: step.tool,
          summary: redact(step.summary).slice(0, 300),
          phase: phaseOf(step.tool),
          startedAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run(),
    );
  }

  finish(id: string, outcome: { ok: boolean; error?: string }): void {
    this.store.write((tx) =>
      tx
        .update(runSteps)
        .set({
          finishedAt: new Date().toISOString(),
          ok: outcome.ok,
          error: outcome.error === undefined ? null : redact(outcome.error).slice(0, 500),
        })
        .where(and(eq(runSteps.id, id), isNull(runSteps.finishedAt)))
        .run(),
    );
  }

  /** Time a call spent waiting on the operator. */
  waited(id: string, ms: number): void {
    if (ms <= 0) return;
    this.store.write((tx) =>
      tx
        .update(runSteps)
        .set({ waitedMs: sql`${runSteps.waitedMs} + ${Math.round(ms)}` })
        .where(eq(runSteps.id, id))
        .run(),
    );
  }

  /** A run ends with calls still open: the abort or the crash cut them off. */
  closeOpen(sessionId: string, why: string): void {
    this.closeOpenAgents(sessionId);
    this.store.write((tx) =>
      tx
        .update(runSteps)
        .set({ finishedAt: new Date().toISOString(), ok: false, error: why })
        .where(and(eq(runSteps.sessionId, sessionId), isNull(runSteps.finishedAt)))
        .run(),
    );
  }

  /** The daemon restarted: no call is open any more. */
  closeAllOpen(why: string): void {
    this.closeAllOpenAgents();
    this.store.write((tx) =>
      tx
        .update(runSteps)
        .set({ finishedAt: new Date().toISOString(), ok: false, error: why })
        .where(isNull(runSteps.finishedAt))
        .run(),
    );
  }

  /**
   * What a run used, added to any earlier part of the same run (a retry on another account). `lines` are the raw token
   * counts since the last save, so adding them never counts a message twice. `reportedCostUsd` is the SDK's own figure,
   * `reportedTokens` its token total, used only when no raw lines were seen.
   */
  addUsage(
    run: Run,
    reportedCostUsd: number,
    lines: UsageLine[],
    reportedTokens = 0,
    accountId: string | null = null,
    purpose: RunPurpose | null = null,
  ): void {
    // Without raw lines, the tokens are what the result message said.
    const added = lines.length > 0 ? lines.reduce((sum, line) => sum + sumTokens(line), 0) : reportedTokens;
    if (reportedCostUsd === 0 && added === 0) return;
    this.store.write((tx) => {
      const had = tx
        .select()
        .from(runUsage)
        .where(and(eq(runUsage.sessionId, run.sessionId), eq(runUsage.runStartedAt, run.createdAt)))
        .get();
      const all = mergeLines([...(had?.breakdown ? (JSON.parse(had.breakdown) as UsageLine[]) : []), ...lines]);
      const now = new Date().toISOString();
      if (had) {
        tx.update(runUsage)
          .set({
            finishedAt: now,
            accountId,
            purpose: had.purpose ?? purpose,
            costUsd: had.costUsd + reportedCostUsd,
            tokens: had.tokens + added,
            breakdown: had.breakdown === null && lines.length === 0 ? null : JSON.stringify(all),
          })
          .where(eq(runUsage.id, had.id))
          .run();
        return;
      }
      tx.insert(runUsage)
        .values({
          id: crypto.randomUUID(),
          sessionId: run.sessionId,
          runStartedAt: run.createdAt,
          finishedAt: now,
          accountId,
          purpose,
          costUsd: reportedCostUsd,
          tokens: added,
          breakdown: lines.length === 0 ? null : JSON.stringify(all),
        })
        .run();
    });
  }

  /** The steps of the run that began at `startedAt` in each Session, oldest first. */
  stepsOf(sessionIds: string[]): StepRow[] {
    if (sessionIds.length === 0) return [];
    return this.store.db
      .select()
      .from(runSteps)
      .where(inArray(runSteps.sessionId, sessionIds))
      .orderBy(runSteps.startedAt)
      .all();
  }

  /** Finished command steps of every run, newest first, for how long a command usually takes. */
  history(): StepFacts[] {
    return this.store.db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.tool, 'Bash'), sql`${runSteps.finishedAt} is not null`))
      .orderBy(desc(runSteps.startedAt))
      .limit(HISTORY_ROWS)
      .all()
      .map(factsOf);
  }

  usageOf(sessionIds: string[]): UsageRow[] {
    if (sessionIds.length === 0) return [];
    return this.store.db.select().from(runUsage).where(inArray(runUsage.sessionId, sessionIds)).all().map(usageRowOf);
  }

  /** The usage of every run that ended since `since`, for the day's total. */
  usageRowsSince(since: string): UsageRow[] {
    return this.store.db.select().from(runUsage).where(gte(runUsage.finishedAt, since)).all().map(usageRowOf);
  }
}

/** One run's saved usage: the SDK's cost, every token, and the raw counts when they were kept. */
export type UsageRow = {
  sessionId: string;
  /** The account the run ended on; null for CLIProxy and runs kept before accounts were recorded. */
  accountId: string | null;
  /** What the run was for; null for a run kept before purposes were recorded. */
  purpose: string | null;
  runStartedAt: string;
  finishedAt: string;
  /** What the SDK reported. */
  costUsd: number;
  tokens: number;
  lines: UsageLine[] | null;
};

function usageRowOf(row: typeof runUsage.$inferSelect): UsageRow {
  return {
    sessionId: row.sessionId,
    accountId: row.accountId,
    purpose: row.purpose,
    runStartedAt: row.runStartedAt,
    finishedAt: row.finishedAt,
    costUsd: row.costUsd,
    tokens: row.tokens,
    lines: row.breakdown === null ? null : (JSON.parse(row.breakdown) as UsageLine[]),
  };
}
