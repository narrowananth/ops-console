import { type Playbook, StepBlock } from '@ops-console/shared';
import { z } from 'zod';
import { useStored } from '../lib/remember';
import { inWords } from './labels';

/** A Playbook as the operator is editing it: a step may be half written, so nothing here is checked yet. */
const draftSchema = z.object({
  name: z.string(),
  rules: z.string(),
  // Drafts kept from before Branch have none.
  branches: z.string().default(''),
  // Drafts kept from before the Jira ticket switch have none.
  jira_ticket: z.boolean().default(false),
  // A draft with no `skill_ids` holds none.
  skill_ids: z.array(z.string()).default([]),
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
  branches: playbook.branches,
  jira_ticket: playbook.jira_ticket,
  skill_ids: playbook.skills.map((skill) => skill.id),
  steps: playbook.steps,
});

/** What a Playbook still lacks before the daemon takes it, in the operator's words; null when nothing. */
export function unfinished(draft: Draft): string | null {
  const lacks = (blank: (step: DraftStep) => boolean) =>
    draft.steps.flatMap((step, at) => (blank(step) ? [`Step ${at + 1}`] : []));
  const parts = [
    draft.name.trim() ? null : 'The Playbook needs a name',
    ...[
      [lacks((step) => !step.title.trim()), 'a title'],
      [lacks((step) => !step.instructions.trim()), 'instructions'],
    ].map(([steps, what]) => {
      const names = steps as string[];
      return names.length > 0 ? `${inWords(names)} ${names.length === 1 ? 'needs' : 'need'} ${what}` : null;
    }),
  ].filter((part) => part !== null);
  return parts.length > 0 ? `${parts.join('. ')}.` : null;
}

const same = (a: Draft, b: Draft) =>
  a.name === b.name &&
  a.rules === b.rules &&
  a.branches === b.branches &&
  a.jira_ticket === b.jira_ticket &&
  a.skill_ids.length === b.skill_ids.length &&
  a.skill_ids.every((id) => b.skill_ids.includes(id)) &&
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
