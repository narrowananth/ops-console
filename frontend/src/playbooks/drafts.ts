import { type Playbook, StepBlock } from '@ops-console/shared';
import { z } from 'zod';
import { useStored } from '../lib/remember';

/** A Playbook as the operator is editing it: a step may be half written, so nothing here is checked yet. */
const draftSchema = z.object({
  name: z.string(),
  rules: z.string(),
  steps: z.array(
    z.object({ block: z.enum(StepBlock), title: z.string(), instructions: z.string(), writes: z.boolean() }),
  ),
});

export type Draft = z.infer<typeof draftSchema>;
export type DraftStep = Draft['steps'][number];

const draftsSchema = z.record(z.string(), draftSchema);
const NONE: Record<string, Draft> = {};

export const draftOf = (playbook: Playbook): Draft => ({
  name: playbook.name,
  rules: playbook.rules,
  steps: playbook.steps,
});

const same = (a: Draft, b: Draft) =>
  a.name === b.name &&
  a.rules === b.rules &&
  a.steps.length === b.steps.length &&
  a.steps.every(
    (step, index) =>
      step.block === b.steps[index]?.block &&
      step.title === b.steps[index]?.title &&
      step.instructions === b.steps[index]?.instructions &&
      step.writes === b.steps[index]?.writes,
  );

/**
 * Unsaved edits per Playbook id, kept in the browser until Save or Discard (Behavior 12). Editing back to what is
 * saved drops the entry, so the row's dot means there is something to save.
 */
export function useDrafts() {
  const [drafts, setDrafts] = useStored('playbooks.drafts', draftsSchema, NONE);
  const edit = (playbook: Playbook, next: Draft) =>
    setDrafts((all) => {
      const { [playbook.id]: _old, ...rest } = all;
      return same(next, draftOf(playbook)) ? rest : { ...rest, [playbook.id]: next };
    });
  const drop = (id: string) =>
    setDrafts((all) => {
      const { [id]: _old, ...rest } = all;
      return rest;
    });
  return { drafts, edit, drop };
}
