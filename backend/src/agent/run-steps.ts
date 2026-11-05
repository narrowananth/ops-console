import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { redact } from '../action-log/redact';
import { runSteps, runUsage } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { phaseOf, type StepFacts } from './run-insight';
import type { Run } from './runs';

/** How long the console keeps the steps and costs of finished runs. */
const KEEP_MS = 30 * 24 * 3600_000;

/** Steps rows kept to say how long a command usually takes. */
const HISTORY_ROWS = 3000;

type StepRow = typeof runSteps.$inferSelect;

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

  /** A run starts: steps and costs older than the keep time go. */
  prune(): void {
    const before = new Date(Date.now() - KEEP_MS).toISOString();
    this.store.write((tx) => {
      tx.delete(runSteps).where(lt(runSteps.startedAt, before)).run();
      tx.delete(runUsage).where(lt(runUsage.finishedAt, before)).run();
    });
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
    this.store.write((tx) =>
      tx
        .update(runSteps)
        .set({ finishedAt: new Date().toISOString(), ok: false, error: why })
        .where(isNull(runSteps.finishedAt))
        .run(),
    );
  }

  /** What a run cost, added to any earlier part of the same run (a retry on another account). */
  addUsage(run: Run, costUsd: number, tokens: number): void {
    if (costUsd === 0 && tokens === 0) return;
    this.store.write((tx) =>
      tx
        .insert(runUsage)
        .values({
          id: crypto.randomUUID(),
          sessionId: run.sessionId,
          runStartedAt: run.createdAt,
          finishedAt: new Date().toISOString(),
          costUsd,
          tokens,
        })
        .onConflictDoUpdate({
          target: [runUsage.sessionId, runUsage.runStartedAt],
          set: {
            finishedAt: new Date().toISOString(),
            costUsd: sql`${runUsage.costUsd} + ${costUsd}`,
            tokens: sql`${runUsage.tokens} + ${tokens}`,
          },
        })
        .run(),
    );
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

  usageOf(sessionIds: string[]): { sessionId: string; runStartedAt: string; costUsd: number; tokens: number }[] {
    if (sessionIds.length === 0) return [];
    return this.store.db.select().from(runUsage).where(inArray(runUsage.sessionId, sessionIds)).all();
  }

  /** What runs that ended since `since` cost together. */
  usageSince(since: string): { costUsd: number; tokens: number; runs: number } {
    const row = this.store.db
      .select({
        costUsd: sql<number>`coalesce(sum(${runUsage.costUsd}), 0)`,
        tokens: sql<number>`coalesce(sum(${runUsage.tokens}), 0)`,
        runs: sql<number>`count(*)`,
      })
      .from(runUsage)
      .where(sql`${runUsage.finishedAt} >= ${since}`)
      .get();
    return { costUsd: row?.costUsd ?? 0, tokens: row?.tokens ?? 0, runs: row?.runs ?? 0 };
  }
}
