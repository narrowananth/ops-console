import { Inject, Injectable } from '@nestjs/common';
import {
  BUILTIN_ID_PREFIX,
  type CreateSkill,
  ErrorCode,
  type PackSkill,
  type Skill,
  type SkillCopy,
  SkillKind,
  type SkillList,
  type SkillPack,
  type SkillPackList,
  type SkillPatch,
  skillCopySchema,
} from '@ops-console/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { installedSkillPacks, playbookBuiltinSkills, playbookSkills, playbooks, skills } from '../db/schema';
import { STORE, type Store, type Tx } from '../db/store';
import { BUILTIN_SKILL_NAMES, type CatalogPack, SKILL_CATALOG } from './skill-catalog';

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

/** A Built-in skill's id. */
export const builtinSkillId = (packId: string, name: string): string => `${BUILTIN_ID_PREFIX}${packId}/${name}`;

/** The pack and name in a Built-in skill's id, or null for any other id. */
export function parseBuiltinId(id: string): { packId: string; name: string } | null {
  if (!id.startsWith(BUILTIN_ID_PREFIX)) return null;
  const rest = id.slice(BUILTIN_ID_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash > 0 && slash < rest.length - 1 ? { packId: rest.slice(0, slash), name: rest.slice(slash + 1) } : null;
}

const catalogPack = (id: string): CatalogPack | undefined => SKILL_CATALOG.find((pack) => pack.id === id);

/** The Skills the operator keeps: Custom ones, the Built-in skills of installed packs, and the ones each Playbook holds. */
@Injectable()
export class SkillsService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  list(): SkillList {
    const held = this.playbooksBySkill();
    const custom = this.store.db
      .select()
      .from(skills)
      .all()
      .map((row) => this.view(row, held));
    const builtin = this.installedBuiltins().map(({ pack, skill }) => this.builtinView(pack, skill, held));
    return { items: [...custom, ...builtin].sort(byName) };
  }

  /** Every pack in the catalog, with whether it is installed. */
  packs(): SkillPackList {
    const installed = this.installedIds();
    return { items: SKILL_CATALOG.map((pack) => this.packView(pack, installed.has(pack.id))) };
  }

  /** Installs a pack: its skills join Yours. Installing an installed pack changes nothing. */
  installPack(id: string): SkillPack {
    const pack = catalogPack(id);
    if (!pack) throw new ApiError(404, ErrorCode.NotFound, 'no such Skill pack');
    this.store.write((tx, emit) => {
      const added = tx.insert(installedSkillPacks).values({ packId: id }).onConflictDoNothing().returning().get();
      if (added) emit('skills.changed', {});
    });
    return this.packView(pack, true);
  }

  /** Uninstalls a pack and takes its skills off every Playbook; a job that was offered one keeps its copy. */
  uninstallPack(id: string): void {
    if (!catalogPack(id)) throw new ApiError(404, ErrorCode.NotFound, 'no such Skill pack');
    this.store.write((tx, emit) => {
      tx.delete(playbookBuiltinSkills).where(eq(playbookBuiltinSkills.packId, id)).run();
      const removed = tx.delete(installedSkillPacks).where(eq(installedSkillPacks.packId, id)).returning().get();
      if (removed) emit('skills.changed', {});
    });
  }

  /** The installed Built-in skill with this name, if any. */
  builtinNamed(name: string): { pack: CatalogPack; skill: PackSkill } | null {
    return this.installedBuiltins().find(({ skill }) => skill.name === name) ?? null;
  }

  /** Every installed skill of one pack, as a run copies them. */
  packCopies(packId: string): SkillCopy[] {
    return this.installedBuiltins()
      .filter(({ pack }) => pack.id === packId)
      .map(({ pack, skill }) => ({ id: builtinSkillId(pack.id, skill.name), kind: SkillKind.Builtin, ...skill }));
  }

  /** The Custom Skill with this name, ignoring case. */
  customNamed(name: string): SkillCopy | null {
    const row = this.store.db.select().from(skills).where(sql`${skills.name} = ${name} COLLATE NOCASE`).get();
    return row ? { ...this.copyOf(row) } : null;
  }

  /** Whether a Built-in skill id names an installed pack's skill. */
  isInstalledBuiltin(id: string): boolean {
    const parsed = parseBuiltinId(id);
    return (
      parsed !== null &&
      this.installedBuiltins().some(({ pack, skill }) => pack.id === parsed.packId && skill.name === parsed.name)
    );
  }

  /** Every Custom Skill and installed Built-in skill, for the menu. */
  menuEntries(): {
    kind: SkillKind.Builtin | SkillKind.Custom;
    name: string;
    description: string;
    pack: string | null;
  }[] {
    return [
      ...this.store.db
        .select()
        .from(skills)
        .all()
        .map((row) => ({ kind: SkillKind.Custom as const, name: row.name, description: row.description, pack: null })),
      ...this.installedBuiltins().map(({ pack, skill }) => ({
        kind: SkillKind.Builtin as const,
        name: skill.name,
        description: skill.description,
        pack: pack.id,
      })),
    ];
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
    this.requireCustom(id);
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
    this.requireCustom(id);
    this.store.write((tx, emit) => {
      this.row(tx, id);
      tx.delete(skills).where(eq(skills.id, id)).run();
      emit('skills.changed', {});
    });
  }

  /** The Skills a Playbook holds now, Custom and Built-in, as a job or a chat copies them. */
  copiesFor(playbookId: string): SkillCopy[] {
    const custom = this.store.db
      .select({ id: skills.id, name: skills.name, description: skills.description, instructions: skills.instructions })
      .from(playbookSkills)
      .innerJoin(skills, eq(skills.id, playbookSkills.skillId))
      .where(eq(playbookSkills.playbookId, playbookId))
      .all()
      .map((row): SkillCopy => ({ ...row, kind: SkillKind.Custom }));
    const held = this.store.db
      .select()
      .from(playbookBuiltinSkills)
      .where(eq(playbookBuiltinSkills.playbookId, playbookId))
      .all();
    const builtin = this.installedBuiltins().flatMap(({ pack, skill }): SkillCopy[] =>
      held.some((row) => row.packId === pack.id && row.skillName === skill.name)
        ? [{ id: builtinSkillId(pack.id, skill.name), kind: SkillKind.Builtin, ...skill }]
        : [],
    );
    return [...custom, ...builtin].sort(byName);
  }

  private copyOf(row: SkillRow): SkillCopy {
    return {
      id: row.id,
      kind: SkillKind.Custom,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
    };
  }

  private installedIds(): Set<string> {
    return new Set(
      this.store.db
        .select({ id: installedSkillPacks.packId })
        .from(installedSkillPacks)
        .all()
        .map((row) => row.id),
    );
  }

  private installedBuiltins(): { pack: CatalogPack; skill: PackSkill }[] {
    const installed = this.installedIds();
    return SKILL_CATALOG.filter((pack) => installed.has(pack.id)).flatMap((pack) =>
      pack.skills.map((skill) => ({ pack, skill })),
    );
  }

  private packView(pack: CatalogPack, installed: boolean): SkillPack {
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      installed,
      skills: pack.skills,
    };
  }

  private builtinView(pack: CatalogPack, skill: PackSkill, held: Map<string, { id: string; name: string }[]>): Skill {
    const id = builtinSkillId(pack.id, skill.name);
    return {
      id,
      kind: SkillKind.Builtin,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      pack: pack.id,
      playbooks: (held.get(id) ?? []).sort(byName),
    };
  }

  /** A Built-in skill is read-only: only its pack's Uninstall removes it. */
  private requireCustom(id: string): void {
    if (parseBuiltinId(id) !== null) {
      throw new ApiError(409, ErrorCode.ReadOnly, 'A Built-in skill is read-only; uninstall its pack to remove it');
    }
  }

  private view(row: SkillRow, held: Map<string, { id: string; name: string }[]>): Skill {
    return {
      id: row.id,
      kind: SkillKind.Custom,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      pack: null,
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
    const builtin = this.store.db
      .select({
        packId: playbookBuiltinSkills.packId,
        skill: playbookBuiltinSkills.skillName,
        id: playbooks.id,
        name: playbooks.name,
      })
      .from(playbookBuiltinSkills)
      .innerJoin(playbooks, eq(playbooks.id, playbookBuiltinSkills.playbookId))
      .all();
    for (const { packId, skill, id, name } of builtin) {
      const key = builtinSkillId(packId, skill);
      map.set(key, [...(map.get(key) ?? []), { id, name }]);
    }
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
    if (taken || BUILTIN_SKILL_NAMES.has(name.toLowerCase())) {
      throw new ApiError(409, ErrorCode.Duplicate, `Another Skill is named ${name}`);
    }
  }
}
