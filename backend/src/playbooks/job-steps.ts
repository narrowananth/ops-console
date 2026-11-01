import { Inject, Injectable } from '@nestjs/common';
import {
  type JobPlaybook,
  type Part,
  PLAYBOOK_LIMITS,
  type PlaybookStep,
  PlaybookStepStatus,
} from '@ops-console/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { redact } from '../action-log/redact';
import { AgentRuntime } from '../agent/runtime';
import { parseAgentJson } from '../common/agent-json';
import { StartupRecovery } from '../common/recovery';
import { playbookSteps } from '../db/schema';
import { type Emit, STORE, type Store, type Tx } from '../db/store';
import { stepOutcomeSchema, stepPrompt } from './prompts';

/** The job a step belongs to. */
export type JobRef = { kind: 'report' | 'fix' | 'agent_review'; id: string };

type StepRow = typeof playbookSteps.$inferSelect;

const COLUMN = {
  report: playbookSteps.reportId,
  fix: playbookSteps.fixId,
  agent_review: playbookSteps.agentReviewId,
} as const;

const KEY = { report: 'reportId', fix: 'fixId', agent_review: 'agentReviewId' } as const;

type Db = Store['db'];

function stepRows(db: Db, job: JobRef): StepRow[] {
  return db.select().from(playbookSteps).where(eq(COLUMN[job.kind], job.id)).orderBy(asc(playbookSteps.position)).all();
}

/** The Playbook a job ran, for the job's view; null for a job from before Playbooks. */
export function jobPlaybook(
  db: Db,
  kind: JobRef['kind'],
  job: { id: string; playbookId: string | null; playbookName: string | null },
): JobPlaybook | null {
  if (job.playbookName === null) return null;
  return {
    id: job.playbookId,
    name: job.playbookName,
    steps: stepRows(db, { kind, id: job.id }).map((row) => ({
      title: row.title,
      writes: row.writes,
      status: row.status,
      summary: row.summary,
    })),
  };
}

/** How a job runs its steps: where, with which rules, and what the first turn is told about the job. */
export type StepRun = {
  job: JobRef;
  sessionId: string;
  /** The job's context, sent before the first step this run takes. */
  brief: string;
  rules: string | null;
  cwd?: string;
  /** Starts a new agent conversation for the first step. */
  fresh?: boolean;
  onPart?: (part: Part) => void;
};

/** Runs a job's copied Playbook steps one turn each, in order, and keeps their status (Behaviors 13 to 15). */
@Injectable()
export class JobSteps {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('playbook steps', () => this.recover());
  }

  /** Writes the job's copy of the steps, all pending. */
  seed(tx: Tx, job: JobRef, steps: PlaybookStep[]): void {
    steps.forEach((step, position) => {
      tx.insert(playbookSteps)
        .values({
          id: crypto.randomUUID(),
          [KEY[job.kind]]: job.id,
          position,
          title: step.title,
          instructions: step.instructions,
          writes: step.writes,
        })
        .run();
    });
  }

  rows(job: JobRef): StepRow[] {
    return stepRows(this.store.db, job);
  }

  /**
   * Runs every step not yet done or skipped, from the first such step. Resolves with null when each one ended done
   * or skipped, or with the failure message that stops the job.
   */
  async run(options: StepRun): Promise<string | null> {
    const all = this.rows(options.job);
    const from = all.findIndex(
      (row) => row.status !== PlaybookStepStatus.Done && row.status !== PlaybookStepStatus.Skipped,
    );
    if (from === -1) return null;
    for (const [index, row] of all.slice(from).entries()) {
      const failure = await this.step(options, row, all.length, index === 0);
      if (failure) return failure;
    }
    return null;
  }

  private async step(options: StepRun, row: StepRow, total: number, first: boolean): Promise<string | null> {
    this.set(row, PlaybookStepStatus.Running, null, { startedAt: new Date().toISOString(), finishedAt: null });
    const prompt = `${first ? `${options.brief}\n\n` : ''}${stepPrompt(row, row.position, total)}`;
    let outcome: { status: PlaybookStepStatus; summary: string };
    try {
      const { finished } = this.runtime.runFor(options.sessionId, prompt, options.onPart ?? null, {
        rules: options.rules,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        fresh: first && options.fresh === true,
      });
      const summary = await finished;
      const parsed = summary.ok ? parseAgentJson(summary.text, stepOutcomeSchema) : null;
      outcome = parsed
        ? { status: parsed.outcome, summary: parsed.summary }
        : {
            status: PlaybookStepStatus.Failed,
            summary: summary.ok ? 'the agent did not answer as asked' : 'the agent run failed',
          };
    } catch (error) {
      outcome = {
        status: PlaybookStepStatus.Failed,
        summary: error instanceof Error ? error.message : 'the agent could not start',
      };
    }
    const summary = redact(outcome.summary.trim()).slice(0, PLAYBOOK_LIMITS.summary);
    this.set(row, outcome.status, summary, { finishedAt: new Date().toISOString() });
    if (outcome.status !== PlaybookStepStatus.Failed) return null;
    return `Step ${row.position + 1} · ${row.title} failed: ${summary}`;
  }

  /** A retry runs the failed step again, and every step after it. */
  reset(tx: Tx, emit: Emit, job: JobRef): void {
    const rows = tx
      .update(playbookSteps)
      .set({ status: PlaybookStepStatus.Pending, summary: null, startedAt: null, finishedAt: null })
      .where(
        and(
          eq(COLUMN[job.kind], job.id),
          inArray(playbookSteps.status, [PlaybookStepStatus.Failed, PlaybookStepStatus.Running]),
        ),
      )
      .returning()
      .all();
    for (const row of rows) this.announce(emit, row);
  }

  private set(
    row: StepRow,
    status: PlaybookStepStatus,
    summary: string | null,
    times: { startedAt?: string; finishedAt: string | null },
  ): void {
    this.store.write((tx, emit) => {
      const updated = tx
        .update(playbookSteps)
        .set({ status, summary, ...times })
        .where(eq(playbookSteps.id, row.id))
        .returning()
        .get();
      if (updated) this.announce(emit, updated);
    });
  }

  private announce(emit: Emit, row: StepRow): void {
    emit('playbook_step.updated', {
      report_id: row.reportId,
      fix_id: row.fixId,
      agent_review_id: row.agentReviewId,
      position: row.position,
      status: row.status,
      summary: row.summary,
    });
  }

  /** A step running when the daemon stopped failed as interrupted (Behavior 32). */
  private recover(): void {
    this.store.write((tx, emit) => {
      const rows = tx
        .update(playbookSteps)
        .set({ status: PlaybookStepStatus.Failed, summary: 'interrupted', finishedAt: new Date().toISOString() })
        .where(eq(playbookSteps.status, PlaybookStepStatus.Running))
        .returning()
        .all();
      for (const row of rows) this.announce(emit, row);
    });
  }
}
