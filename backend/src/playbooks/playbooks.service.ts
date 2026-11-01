import { Inject, Injectable } from '@nestjs/common';
import {
  type CreatePlaybook,
  ErrorCode,
  PLAYBOOK_TRIGGERS,
  type Playbook,
  type PlaybookList,
  type PlaybookPatch,
  type PlaybookStep,
  PlaybookTrigger,
  playbookStepSchema,
  SessionKind,
} from '@ops-console/shared';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { fixes, playbooks, playbookTriggers, reports, reviews, type sessions } from '../db/schema';
import { STORE, type Store, type Tx } from '../db/store';
import { BUILTIN_STEPS, builtinId, builtinName, STEP_BLOCKS, WRITING_BLOCKS } from './blocks';

type PlaybookRow = typeof playbooks.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

/** What a job copies when it starts: the Playbook its Trigger holds, or the built-in. */
export type PlaybookCopy = { id: string | null; name: string; rules: string; steps: PlaybookStep[] };

const stepsOf = (row: PlaybookRow): PlaybookStep[] => {
  const parsed = z.array(playbookStepSchema).safeParse(JSON.parse(row.steps));
  return parsed.success ? parsed.data : [];
};

/** A step from a block that writes keeps the scratch copy tag; only Custom step sets its own (Settled). */
const tagged = (steps: PlaybookStep[]): PlaybookStep[] =>
  steps.map((step) => (WRITING_BLOCKS.has(step.block) ? { ...step, writes: true } : step));

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Playbooks, the Trigger each one holds, and the rules a chat or a job gets from them. */
@Injectable()
export class PlaybooksService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  list(): PlaybookList {
    const held = this.held();
    const own = this.store.db
      .select()
      .from(playbooks)
      .all()
      .map((row) => this.view(row, held))
      .sort(byName);
    const builtins = PLAYBOOK_TRIGGERS.map((trigger) => this.builtin(trigger, held));
    return { items: [...own, ...builtins], blocks: STEP_BLOCKS };
  }

  create(input: Required<CreatePlaybook>): Playbook {
    const row = this.store.write((tx) => {
      this.requireFreeName(tx, input.name, null);
      return tx
        .insert(playbooks)
        .values({
          id: crypto.randomUUID(),
          name: input.name,
          rules: input.rules,
          steps: JSON.stringify(tagged(input.steps)),
        })
        .returning()
        .get();
    });
    return this.view(row, this.held());
  }

  patch(id: string, patch: PlaybookPatch): Playbook {
    const row = this.store.write((tx) => {
      const current = this.row(tx, id);
      if (patch.name !== undefined) this.requireFreeName(tx, patch.name, id);
      const steps = patch.steps ? tagged(patch.steps) : null;
      if (steps && this.triggersOf(tx, id).includes(PlaybookTrigger.ReviewPr)) this.requireReadOnly(steps);
      return tx
        .update(playbooks)
        .set({
          name: patch.name ?? current.name,
          rules: patch.rules ?? current.rules,
          steps: steps ? JSON.stringify(steps) : current.steps,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(playbooks.id, id))
        .returning()
        .get();
    });
    return this.view(row, this.held());
  }

  /** Its Triggers go back to their built-in; jobs that ran it keep their copy. */
  remove(id: string): void {
    this.store.write((tx) => {
      this.row(tx, id);
      tx.delete(playbooks).where(eq(playbooks.id, id)).run();
    });
  }

  /** Attaches a Playbook to the Trigger, replacing the one it held; null, or the Trigger's own built-in, detaches. */
  setTrigger(trigger: PlaybookTrigger, playbookId: string | null): Playbook[] {
    this.store.write((tx) => {
      if (playbookId === null || playbookId === builtinId(trigger)) {
        tx.delete(playbookTriggers).where(eq(playbookTriggers.trigger, trigger)).run();
        return;
      }
      if (playbookId.startsWith('builtin:')) {
        throw new ApiError(409, ErrorCode.InvalidState, 'A built-in Playbook stays on its own Trigger');
      }
      const row = this.row(tx, playbookId);
      if (trigger === PlaybookTrigger.ReviewPr) this.requireReadOnly(stepsOf(row));
      tx.insert(playbookTriggers)
        .values({ trigger, playbookId })
        .onConflictDoUpdate({ target: playbookTriggers.trigger, set: { playbookId } })
        .run();
    });
    return this.list().items;
  }

  /** The copy a job takes when it starts (Behavior 13). */
  copyFor(trigger: PlaybookTrigger): PlaybookCopy {
    const found = this.store.db
      .select({ playbook: playbooks })
      .from(playbookTriggers)
      .innerJoin(playbooks, eq(playbooks.id, playbookTriggers.playbookId))
      .where(eq(playbookTriggers.trigger, trigger))
      .get();
    if (!found) return { id: null, name: builtinName(trigger), rules: '', steps: BUILTIN_STEPS[trigger] };
    return {
      id: found.playbook.id,
      name: found.playbook.name,
      rules: found.playbook.rules,
      steps: stepsOf(found.playbook),
    };
  }

  /**
   * The rules a chat turn in this Session runs with, read at each turn, and the Playbook they come from when it is
   * not built-in. An Alert's Session uses what the Alert's latest job copied (Behavior 21). A `devtools` Session has
   * no Trigger: its own instructions already cover Connections and PROD.
   */
  forSession(session: SessionRow): { rules: string | null; playbook: { id: string; name: string } | null } {
    if (session.alertId !== null) return this.latestAlertJob(session.alertId);
    if (session.kind === SessionKind.Devtools) return { rules: null, playbook: null };
    const trigger =
      session.kind === SessionKind.PrReview ? PlaybookTrigger.ThreadReply : PlaybookTrigger.SessionMessage;
    const copy = this.copyFor(trigger);
    return { rules: copy.rules || null, playbook: copy.id ? { id: copy.id, name: copy.name } : null };
  }

  private latestAlertJob(alertId: string): ReturnType<PlaybooksService['forSession']> {
    const report = this.store.db
      .select({
        id: reports.playbookId,
        name: reports.playbookName,
        rules: reports.playbookRules,
        at: reports.createdAt,
      })
      .from(reports)
      .where(eq(reports.alertId, alertId))
      .orderBy(desc(reports.version))
      .get();
    const fix = this.store.db
      .select({ id: fixes.playbookId, name: fixes.playbookName, rules: fixes.playbookRules, at: fixes.startedAt })
      .from(fixes)
      .innerJoin(reviews, eq(reviews.id, fixes.reviewId))
      .innerJoin(reports, eq(reports.id, reviews.reportId))
      .where(eq(reports.alertId, alertId))
      .orderBy(desc(fixes.startedAt))
      .get();
    const latest = fix && (!report || fix.at >= report.at) ? fix : report;
    if (!latest) return { rules: null, playbook: null };
    return {
      rules: latest.rules || null,
      playbook: latest.id && latest.name ? { id: latest.id, name: latest.name } : null,
    };
  }

  private builtin(trigger: PlaybookTrigger, held: Map<string, PlaybookTrigger[]>): Playbook {
    const taken = new Set([...held.values()].flat());
    return {
      id: builtinId(trigger),
      builtin: true,
      name: builtinName(trigger),
      rules: '',
      steps: BUILTIN_STEPS[trigger],
      triggers: taken.has(trigger) ? [] : [trigger],
      updated_at: null,
    };
  }

  private view(row: PlaybookRow, held: Map<string, PlaybookTrigger[]>): Playbook {
    return {
      id: row.id,
      builtin: false,
      name: row.name,
      rules: row.rules,
      steps: stepsOf(row),
      triggers: held.get(row.id) ?? [],
      updated_at: row.updatedAt,
    };
  }

  /** Playbook id to the Triggers holding it, in page order. */
  private held(): Map<string, PlaybookTrigger[]> {
    const map = new Map<string, PlaybookTrigger[]>();
    const rows = this.store.db.select().from(playbookTriggers).all();
    for (const trigger of PLAYBOOK_TRIGGERS) {
      const row = rows.find((candidate) => candidate.trigger === trigger);
      if (row) map.set(row.playbookId, [...(map.get(row.playbookId) ?? []), trigger]);
    }
    return map;
  }

  private triggersOf(tx: Tx, id: string): PlaybookTrigger[] {
    return tx
      .select({ trigger: playbookTriggers.trigger })
      .from(playbookTriggers)
      .where(eq(playbookTriggers.playbookId, id))
      .all()
      .map((row) => row.trigger);
  }

  private row(tx: Tx, id: string): PlaybookRow {
    if (id.startsWith('builtin:')) {
      throw new ApiError(409, ErrorCode.InvalidState, 'A built-in Playbook is read-only; Duplicate it to change it');
    }
    const row = tx.select().from(playbooks).where(eq(playbooks.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Playbook');
    return row;
  }

  private requireFreeName(tx: Tx, name: string, except: string | null): void {
    const taken = tx
      .select({ id: playbooks.id })
      .from(playbooks)
      .where(
        and(sql`${playbooks.name} = ${name} COLLATE NOCASE`, except === null ? undefined : ne(playbooks.id, except)),
      )
      .get();
    if (taken) throw new ApiError(409, ErrorCode.Duplicate, `Another Playbook is named ${name}`);
  }

  /** Review PR reads only: no step with the scratch copy tag reaches it (Behavior 11). */
  private requireReadOnly(steps: PlaybookStep[]): void {
    const writing = steps.find((step) => step.writes);
    if (writing) {
      throw new ApiError(409, ErrorCode.InvalidState, `Review PR reads only: remove ${writing.title} first.`);
    }
  }
}
