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

export const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
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
export const heldSkillSchema = z.object({ id: z.string(), name: z.string(), description: z.string() });

export type HeldSkill = z.infer<typeof heldSkillSchema>;

/** A Skill as a job copied it when it started, the text a run hands the agent. */
export const skillCopySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
});

export type SkillCopy = z.infer<typeof skillCopySchema>;

/** A Skill a job was offered, as its card shows it. Null id once the Skill is deleted. */
export const offeredSkillSchema = z.object({ id: z.string().nullable(), name: z.string() });

export type OfferedSkill = z.infer<typeof offeredSkillSchema>;
