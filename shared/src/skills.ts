import { z } from 'zod';

export const SKILL_LIMITS = { name: 64, description: 1024, instructions: 20000, perPlaybook: 8 } as const;

/** Lowercase letters, digits and hyphens; Claude Code names a skill's folder and its listing by this. */
const SKILL_NAME = /^[a-z0-9-]+$/;

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SKILL_LIMITS.name)
  .regex(SKILL_NAME, 'lowercase letters, digits and hyphens');
const descriptionSchema = z.string().trim().min(1).max(SKILL_LIMITS.description);
const instructionsSchema = z.string().trim().min(1).max(SKILL_LIMITS.instructions);

/** Where a skill comes from: a Skill pack the operator installed, the operator's own Skills, or the Repo's folder. */
export enum SkillKind {
  Builtin = 'builtin',
  Custom = 'custom',
  Project = 'project',
}

/** A Built-in skill's id: `builtin:<pack id>/<skill name>`. */
export const BUILTIN_ID_PREFIX = 'builtin:';

export const skillSchema = z.object({
  id: z.string(),
  /** Built-in or Custom: Project skills are not Skills and are never listed here. */
  kind: z.enum([SkillKind.Builtin, SkillKind.Custom]),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  /** The pack a Built-in skill came from; null for a Custom Skill. */
  pack: z.string().nullable(),
  /** The Playbooks holding it, A to Z. */
  playbooks: z.array(z.object({ id: z.string(), name: z.string() })),
});

export type Skill = z.infer<typeof skillSchema>;

export const skillListSchema = z.object({ items: z.array(skillSchema) });

export type SkillList = z.infer<typeof skillListSchema>;

export const createSkillSchema = z
  .object({ name: nameSchema, description: descriptionSchema, instructions: instructionsSchema })
  .strict();

export type CreateSkill = z.infer<typeof createSkillSchema>;

export const skillPatchSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    instructions: instructionsSchema.optional(),
  })
  .strict();

export type SkillPatch = z.infer<typeof skillPatchSchema>;

/** A Skill a Playbook holds, as listed on the Playbook. */
export const heldSkillSchema = z.object({
  id: z.string(),
  kind: z.enum([SkillKind.Builtin, SkillKind.Custom]),
  name: z.string(),
  description: z.string(),
});

export type HeldSkill = z.infer<typeof heldSkillSchema>;

/** A Skill as a job copied it when it started, the text a run hands the agent. */
export const skillCopySchema = z.object({
  id: z.string(),
  /** Absent means a Custom Skill. */
  kind: z.enum([SkillKind.Builtin, SkillKind.Custom]).optional(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
});

export type SkillCopy = z.infer<typeof skillCopySchema>;

/** A Skill a job was offered, as its card shows it. Null id once the Skill is deleted. */
export const offeredSkillSchema = z.object({ id: z.string().nullable(), name: z.string() });

export type OfferedSkill = z.infer<typeof offeredSkillSchema>;

/** The skill a message names: picked from the `/` menu or typed as `/name`. */
export const skillRefSchema = z.object({
  kind: z.enum(SkillKind),
  name: z.string().trim().min(1).max(SKILL_LIMITS.name),
});

export type SkillRef = z.infer<typeof skillRefSchema>;

/** One skill of a Skill pack. */
export const packSkillSchema = z.object({ name: z.string(), description: z.string(), instructions: z.string() });

export type PackSkill = z.infer<typeof packSkillSchema>;

/** A Skill pack as Discover lists it. */
export const skillPackSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  installed: z.boolean(),
  skills: z.array(packSkillSchema),
});

export type SkillPack = z.infer<typeof skillPackSchema>;

export const skillPackListSchema = z.object({ items: z.array(skillPackSchema) });

export type SkillPackList = z.infer<typeof skillPackListSchema>;

/** A row of the `/` menu. */
export const skillMenuItemSchema = z.object({
  kind: z.enum(SkillKind),
  name: z.string(),
  description: z.string(),
  /** The pack of a Built-in skill. */
  pack: z.string().nullable(),
});

export type SkillMenuItem = z.infer<typeof skillMenuItemSchema>;

export const skillMenuSchema = z.object({ items: z.array(skillMenuItemSchema) });

export type SkillMenu = z.infer<typeof skillMenuSchema>;

export const skillMenuQuerySchema = z.object({
  session_id: z.string().min(1).optional(),
  repo_id: z.string().min(1).optional(),
  q: z.string().optional(),
});
