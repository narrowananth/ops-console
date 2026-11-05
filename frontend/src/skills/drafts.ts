import type { Skill } from '@ops-console/shared';
import { z } from 'zod';
import { useStored } from '../lib/remember';

/** A Skill as the operator is editing it: not checked until Save. */
const draftSchema = z.object({ name: z.string(), description: z.string(), instructions: z.string() });

export type Draft = z.infer<typeof draftSchema>;

const draftsSchema = z.record(z.string(), draftSchema);
const NONE: Record<string, Draft> = {};

export const draftOf = (skill: Skill): Draft => ({
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
});

const same = (a: Draft, b: Draft) =>
  a.name === b.name && a.description === b.description && a.instructions === b.instructions;

/** Unsaved edits per Skill id, kept in the browser until Save or Discard. Editing back to what is saved drops it. */
export function useDrafts() {
  const [drafts, setDrafts] = useStored('skills.drafts', draftsSchema, NONE);
  const edit = (skill: Skill, next: Draft) =>
    setDrafts((all) => {
      const { [skill.id]: _old, ...rest } = all;
      return same(next, draftOf(skill)) ? rest : { ...rest, [skill.id]: next };
    });
  const drop = (id: string) =>
    setDrafts((all) => {
      const { [id]: _old, ...rest } = all;
      return rest;
    });
  return { drafts, edit, drop };
}
