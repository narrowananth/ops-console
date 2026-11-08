import { RULES_LONG, tokens } from './labels';

/** What the Rules cost the agent on every turn, as an estimate (Behaviors 22 and 23). */
export function RulesMeter({ characters, warn }: { characters: number; warn: boolean }) {
  const long = warn && characters > RULES_LONG;
  return (
    <p className={`m-0 rounded-lg px-3 py-2 text-xs ${long ? 'bg-accent-100' : 'bg-neutral-200'}`}>
      <b>≈ {tokens(characters).toLocaleString()} tokens</b>, sent on every turn of every run.{' '}
      {long ? 'Long. Move how-to text into a Skill.' : 'Keep only what is always true; put methods in a Skill.'}
    </p>
  );
}

/** What the held Skills cost on every turn: their names and descriptions only (Behavior 24). */
export function SkillsMeter({ characters }: { characters: number }) {
  return (
    <p className="m-0 rounded-lg bg-neutral-200 px-3 py-2 text-xs">
      <b>≈ {tokens(characters).toLocaleString()} tokens</b> per turn: names and descriptions only. A Skill's full text
      costs tokens only when a step loads it.
    </p>
  );
}
