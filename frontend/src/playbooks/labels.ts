import {
  JOB_TRIGGERS,
  PLAYBOOK_LIMITS,
  type Playbook,
  type PlaybookStep,
  PlaybookTrigger,
  TRIGGER_LABELS,
} from '@ops-console/shared';

/** "Monitor · Verify". */
export const triggerName = (trigger: PlaybookTrigger) =>
  `${TRIGGER_LABELS[trigger].tab} · ${TRIGGER_LABELS[trigger].label}`;

/** "Fix", "Fix and Ask", "Verify, Fix and Ask". */
export function inWords(words: string[]): string {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The operator's Playbook a Trigger holds; none when it runs its built-in. */
export const holderOf = (items: Playbook[], trigger: PlaybookTrigger) =>
  items.find((playbook) => !playbook.builtin && playbook.triggers.includes(trigger));

/** The built-in Playbook a Trigger runs when it holds none of the operator's. */
export const builtinFor = (items: Playbook[], trigger: PlaybookTrigger) =>
  items.find((playbook) => playbook.id === `builtin:${trigger}`);

/** A button that starts a job names the Playbook it runs, when that is not the built-in. */
export const withPlaybook = (label: string, playbook: Playbook | undefined) =>
  playbook ? `${label} · ${playbook.name}` : label;

/** The first of `base`, `base 2`, `base 3`… that no Playbook is named, case ignored. */
export function freeName(base: string, items: Playbook[]): string {
  const taken = new Set(items.map((playbook) => playbook.name.toLowerCase()));
  const cut = (name: string, suffix: string) => `${name.slice(0, PLAYBOOK_LIMITS.name - suffix.length)}${suffix}`;
  for (let number = 1; ; number += 1) {
    const name = cut(base, number === 1 ? '' : ` ${number}`);
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** What the console does itself after the last step, per job Trigger. */
export const CLOSING_TURN: Partial<Record<PlaybookTrigger, string>> = {
  [PlaybookTrigger.Verify]: 'write the Report',
  [PlaybookTrigger.Fix]: 'commit, push and open the PR',
  [PlaybookTrigger.ReviewPr]: 'write findings, checklist and verdict',
  [PlaybookTrigger.CheckReply]: 'give the verdict and the reply',
  [PlaybookTrigger.AddressComments]: 'report each thread done or declined',
};

/** Held only by chats, which use the rules and never run steps. */
export const chatOnly = (triggers: PlaybookTrigger[]) =>
  triggers.length > 0 && triggers.every((trigger) => !JOB_TRIGGERS.includes(trigger));

/** Review PR reads only, so a Playbook with a step tagged "scratch copy" cannot go on it. */
export function reviewRefusal(trigger: PlaybookTrigger, steps: PlaybookStep[]): string | null {
  const writing = steps.find((step) => step.writes);
  if (trigger !== PlaybookTrigger.ReviewPr || !writing) return null;
  return `${TRIGGER_LABELS[trigger].label} reads only: remove ${writing.title} first.`;
}
