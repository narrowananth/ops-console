import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateSkill,
  ErrorCode,
  type Skill,
  type SkillCopy,
  type SkillList,
  type SkillPatch,
  skillCopySchema,
} from '@ops-console/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { playbookSkills, playbooks, skills } from '../db/schema';
import { STORE, type Store, type Tx } from '../db/store';

type SkillRow = typeof skills.$inferSelect;

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** A job's stored Skills. */
export function parseSkillCopies(json: string | null): SkillCopy[] {
  return json === null ? [] : z.array(skillCopySchema).parse(JSON.parse(json));
}

/** The column a job stores the Skills it was offered in; null for none. */
export const skillCopiesJson = (copies: SkillCopy[]): string | null =>
  copies.length === 0 ? null : JSON.stringify(copies);

/** The Skills the operator keeps, and the ones each Playbook holds. */
@Injectable()
export class SkillsService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  list(): SkillList {
    const held = this.playbooksBySkill();
    return {
      items: this.store.db
        .select()
        .from(skills)
        .all()
        .map((row) => this.view(row, held))
        .sort(byName),
    };
  }

  create(input: CreateSkill): Skill {
    const row = this.store.write((tx, emit) => {
      this.requireFreeName(tx, input.name, null);
      const created = tx
        .insert(skills)
        .values({ id: crypto.randomUUID(), ...input })
        .returning()
        .get();
      emit('skills.changed', {});
      return created;
    });
    return this.view(row, this.playbooksBySkill());
  }

  patch(id: string, patch: SkillPatch): Skill {
    const row = this.store.write((tx, emit) => {
      const current = this.row(tx, id);
      if (patch.name !== undefined) this.requireFreeName(tx, patch.name, id);
      const updated = tx
        .update(skills)
        .set({
          name: patch.name ?? current.name,
          description: patch.description ?? current.description,
          instructions: patch.instructions ?? current.instructions,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(skills.id, id))
        .returning()
        .get();
      emit('skills.changed', {});
      return updated;
    });
    return this.view(row, this.playbooksBySkill());
  }

  /** Takes the Skill off every Playbook holding it; jobs that were offered it keep their copy. */
  remove(id: string): void {
    this.store.write((tx, emit) => {
      this.row(tx, id);
      tx.delete(skills).where(eq(skills.id, id)).run();
      emit('skills.changed', {});
    });
  }

  /** The Skills a Playbook holds now, as a job or a chat copies them. */
  copiesFor(playbookId: string): SkillCopy[] {
    return this.store.db
      .select({ id: skills.id, name: skills.name, description: skills.description, instructions: skills.instructions })
      .from(playbookSkills)
      .innerJoin(skills, eq(skills.id, playbookSkills.skillId))
      .where(eq(playbookSkills.playbookId, playbookId))
      .all()
      .sort(byName);
  }

  private view(row: SkillRow, held: Map<string, { id: string; name: string }[]>): Skill {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      playbooks: (held.get(row.id) ?? []).sort(byName),
    };
  }

  private playbooksBySkill(): Map<string, { id: string; name: string }[]> {
    const map = new Map<string, { id: string; name: string }[]>();
    const rows = this.store.db
      .select({ skillId: playbookSkills.skillId, id: playbooks.id, name: playbooks.name })
      .from(playbookSkills)
      .innerJoin(playbooks, eq(playbooks.id, playbookSkills.playbookId))
      .all();
    for (const { skillId, id, name } of rows) map.set(skillId, [...(map.get(skillId) ?? []), { id, name }]);
    return map;
  }

  private row(tx: Tx, id: string): SkillRow {
    const row = tx.select().from(skills).where(eq(skills.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Skill');
    return row;
  }

  private requireFreeName(tx: Tx, name: string, except: string | null): void {
    const taken = tx
      .select({ id: skills.id })
      .from(skills)
      .where(and(sql`${skills.name} = ${name} COLLATE NOCASE`, except === null ? undefined : ne(skills.id, except)))
      .get();
    if (taken) throw new ApiError(409, ErrorCode.Duplicate, `Another Skill is named ${name}`);
  }
}
