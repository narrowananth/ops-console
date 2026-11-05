import { Inject, Injectable } from '@nestjs/common';
import {
  type CreatePlaybook,
  ErrorCode,
  type HeldSkill,
  PLAYBOOK_TRIGGERS,
  type Playbook,
  type PlaybookList,
  type PlaybookPatch,
  type PlaybookStep,
  PlaybookTrigger,
  playbookStepSchema,
  SessionKind,
  type SkillCopy,
} from '@ops-console/shared';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import {
  fixes,
  playbookSkills,
  playbooks,
  playbookTriggers,
  reports,
  reviews,
  type sessions,
  skills,
} from '../db/schema';
import { STORE, type Store, type Tx } from '../db/store';
import { builtinId, builtinName, STEP_BLOCKS, WRITING_BLOCKS } from './blocks';
import { BUILTIN_RULES, BUILTIN_STEPS } from './builtins';
import { parseSkillCopies, SkillsService } from './skills.service';

type PlaybookRow = typeof playbooks.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

/** What a job copies when it starts: the Playbook its Trigger holds, or the built-in. */
export type PlaybookCopy = {
  id: string | null;
  name: string;
  rules: string;
  branches: string;
  jiraTicket: boolean;
  steps: PlaybookStep[];
  /** The Skills it holds; none for a built-in. */
  skills: SkillCopy[];
};

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
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SkillsService) private readonly skills: SkillsService,
  ) {}

  list(): PlaybookList {
    const held = this.held();
    const heldSkills = this.heldSkills();
    const own = this.store.db
      .select()
      .from(playbooks)
      .all()
      .map((row) => this.view(row, held, heldSkills))
      .sort(byName);
    const builtins = PLAYBOOK_TRIGGERS.map((trigger) => this.builtin(trigger, held));
    return { items: [...own, ...builtins], blocks: STEP_BLOCKS };
  }

  create(input: Required<CreatePlaybook>): Playbook {
    const row = this.store.write((tx) => {
      this.requireFreeName(tx, input.name, null);
      const created = tx
        .insert(playbooks)
        .values({
          id: crypto.randomUUID(),
          name: input.name,
          rules: input.rules,
          branches: input.branches,
          jiraTicket: input.jira_ticket,
          steps: JSON.stringify(tagged(input.steps)),
        })
        .returning()
        .get();
      this.holdSkills(tx, created.id, input.skill_ids);
      return created;
    });
    return this.view(row, this.held(), this.heldSkills());
  }

  patch(id: string, patch: PlaybookPatch): Playbook {
    const row = this.store.write((tx) => {
      const current = this.row(tx, id);
      if (patch.name !== undefined) this.requireFreeName(tx, patch.name, id);
      const steps = patch.steps ? tagged(patch.steps) : null;
      if (patch.skill_ids !== undefined) this.holdSkills(tx, id, patch.skill_ids);
      return tx
        .update(playbooks)
        .set({
          name: patch.name ?? current.name,
          rules: patch.rules ?? current.rules,
          branches: patch.branches ?? current.branches,
          jiraTicket: patch.jira_ticket ?? current.jiraTicket,
          steps: steps ? JSON.stringify(steps) : current.steps,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(playbooks.id, id))
        .returning()
        .get();
    });
    return this.view(row, this.held(), this.heldSkills());
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
      this.row(tx, playbookId);
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
    if (!found) {
      return {
        id: null,
        name: builtinName(trigger),
        rules: BUILTIN_RULES[trigger],
        branches: '',
        jiraTicket: false,
        steps: BUILTIN_STEPS[trigger],
        skills: [],
      };
    }
    return {
      id: found.playbook.id,
      name: found.playbook.name,
      rules: found.playbook.rules,
      branches: found.playbook.branches,
      jiraTicket: found.playbook.jiraTicket,
      steps: stepsOf(found.playbook),
      skills: this.skills.copiesFor(found.playbook.id),
    };
  }

  /**
   * The rules a chat turn in this Session runs with, read at each turn, and the Playbook they come from when it is
   * not built-in. An Alert's Session uses what the Alert's latest job copied (Behavior 21). A `devtools` Session has
   * no Trigger: its own instructions already cover Connections and PROD.
   */
  forSession(session: SessionRow): {
    rules: string | null;
    skills: SkillCopy[];
    playbook: { id: string; name: string } | null;
  } {
    if (session.alertId !== null) return this.latestAlertJob(session.alertId);
    if (session.kind === SessionKind.Devtools) return { rules: null, skills: [], playbook: null };
    const trigger =
      session.kind === SessionKind.PrReview ? PlaybookTrigger.ThreadReply : PlaybookTrigger.SessionMessage;
    const copy = this.copyFor(trigger);
    return {
      rules: copy.rules || null,
      skills: copy.skills,
      playbook: copy.id ? { id: copy.id, name: copy.name } : null,
    };
  }

  private latestAlertJob(alertId: string): ReturnType<PlaybooksService['forSession']> {
    const report = this.store.db
      .select({
        id: reports.playbookId,
        name: reports.playbookName,
        rules: reports.playbookRules,
        skills: reports.playbookSkills,
        at: reports.createdAt,
      })
      .from(reports)
      .where(eq(reports.alertId, alertId))
      .orderBy(desc(reports.version))
      .get();
    const fix = this.store.db
      .select({
        id: fixes.playbookId,
        name: fixes.playbookName,
        rules: fixes.playbookRules,
        skills: fixes.playbookSkills,
        at: fixes.startedAt,
      })
      .from(fixes)
      .innerJoin(reviews, eq(reviews.id, fixes.reviewId))
      .innerJoin(reports, eq(reports.id, reviews.reportId))
      .where(eq(reports.alertId, alertId))
      .orderBy(desc(fixes.startedAt))
      .get();
    const latest = fix && (!report || fix.at >= report.at) ? fix : report;
    if (!latest) return { rules: null, skills: [], playbook: null };
    return {
      rules: latest.rules || null,
      skills: parseSkillCopies(latest.skills),
      playbook: latest.id && latest.name ? { id: latest.id, name: latest.name } : null,
    };
  }

  private builtin(trigger: PlaybookTrigger, held: Map<string, PlaybookTrigger[]>): Playbook {
    const taken = new Set([...held.values()].flat());
    return {
      id: builtinId(trigger),
      builtin: true,
      name: builtinName(trigger),
      rules: BUILTIN_RULES[trigger],
      branches: '',
      jira_ticket: false,
      steps: BUILTIN_STEPS[trigger],
      skills: [],
      triggers: taken.has(trigger) ? [] : [trigger],
      updated_at: null,
    };
  }

  private view(row: PlaybookRow, held: Map<string, PlaybookTrigger[]>, heldSkills: Map<string, HeldSkill[]>): Playbook {
    return {
      id: row.id,
      builtin: false,
      name: row.name,
      rules: row.rules,
      branches: row.branches,
      jira_ticket: row.jiraTicket,
      steps: stepsOf(row),
      skills: heldSkills.get(row.id) ?? [],
      triggers: held.get(row.id) ?? [],
      updated_at: row.updatedAt,
    };
  }

  /** Playbook id to the Skills it holds, A to Z. */
  private heldSkills(): Map<string, HeldSkill[]> {
    const map = new Map<string, HeldSkill[]>();
    const rows = this.store.db
      .select({
        playbookId: playbookSkills.playbookId,
        id: skills.id,
        name: skills.name,
        description: skills.description,
      })
      .from(playbookSkills)
      .innerJoin(skills, eq(skills.id, playbookSkills.skillId))
      .all();
    for (const { playbookId, ...skill } of rows) map.set(playbookId, [...(map.get(playbookId) ?? []), skill]);
    for (const list of map.values()) list.sort(byName);
    return map;
  }

  /** Replaces the Skills the Playbook holds. */
  private holdSkills(tx: Tx, playbookId: string, skillIds: string[]): void {
    if (skillIds.length > 0) {
      const found = tx.select({ id: skills.id }).from(skills).where(inArray(skills.id, skillIds)).all();
      if (found.length !== skillIds.length) throw new ApiError(404, ErrorCode.NotFound, 'no such Skill');
    }
    tx.delete(playbookSkills).where(eq(playbookSkills.playbookId, playbookId)).run();
    for (const skillId of skillIds) tx.insert(playbookSkills).values({ playbookId, skillId }).run();
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
}
