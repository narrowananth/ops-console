import type { Skill } from '@ops-console/shared';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { useCreateSkill, useSkills } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { ascending } from '../lib/sort';
import { type Draft, draftOf, useDrafts } from './drafts';
import { SkillEditor } from './skill-editor';

const PLACEHOLDER = {
  description: 'Say when the agent should use this Skill.',
  instructions: 'Write the method the agent follows.',
};

/** The first of `new-skill`, `new-skill-2`, `new-skill-3`… that no Skill is named, case ignored. */
function freeName(items: Skill[]): string {
  const taken = new Set(items.map((skill) => skill.name.toLowerCase()));
  for (let number = 1; ; number += 1) {
    const name = number === 1 ? 'new-skill' : `new-skill-${number}`;
    if (!taken.has(name)) return name;
  }
}

/** New Skill with placeholder text to replace, opened at once. */
function useNewSkill() {
  const list = useSkills();
  const create = useCreateSkill();
  const [, setAddress] = useAddress('skill');
  return {
    ready: Boolean(list.data) && !create.isPending,
    error: create.error?.message ?? null,
    start: () =>
      list.data &&
      create.mutate(
        { name: freeName(list.data.items), ...PLACEHOLDER },
        { onSuccess: (made) => setAddress({ skill: made.id }) },
      ),
  };
}

/** In the page header. */
export function NewSkillButton() {
  const create = useNewSkill();
  return (
    <>
      {create.error && (
        <span role="alert" className="text-xs text-accent-700">
          {create.error}
        </span>
      )}
      <Button disabled={!create.ready} onClick={create.start}>
        + New Skill
      </Button>
    </>
  );
}

export function SkillsView() {
  const list = useSkills();
  const [address, setAddress] = useAddress('skill');
  const { drafts, edit, drop } = useDrafts();
  const create = useNewSkill();

  if (list.isPending) return <Empty>Reading Skills…</Empty>;
  if (list.isError)
    return (
      <Empty>
        Could not read Skills: {list.error.message}{' '}
        <Button className="ml-2 px-2.5 py-1 text-xs" onClick={() => void list.refetch()}>
          Retry
        </Button>
      </Empty>
    );
  const items = ascending(list.data.items, (skill) => skill.name);
  const open = items.find((skill) => skill.id === address.skill) ?? items[0];
  if (!open)
    return (
      <div className="flex flex-col items-start gap-3 px-6 py-5 text-[13px] text-neutral-700">
        <p className="m-0">No Skills yet. A Skill is a method the agent can load while a Playbook runs.</p>
        <Button variant="primary" disabled={!create.ready} onClick={create.start}>
          New Skill
        </Button>
        {create.error && (
          <p role="alert" className="m-0 text-xs text-accent-700">
            {create.error}
          </p>
        )}
      </div>
    );
  const working: Draft = drafts[open.id] ?? draftOf(open);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside
        aria-label="Skills"
        className="flex w-80 flex-none flex-col gap-0.5 overflow-y-auto border-r border-line px-3 py-4"
      >
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {items.map((skill) => (
            <li key={skill.id}>
              <button
                type="button"
                aria-current={skill.id === open.id ? 'true' : undefined}
                onClick={() => setAddress({ skill: skill.id })}
                className={`flex w-full items-center gap-2 px-2.5 py-2 text-[13px] ${item(skill.id === open.id)}`}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono font-semibold">{skill.name}</span>
                  <span className="truncate text-xs text-neutral-700">
                    {skill.playbooks.length} {skill.playbooks.length === 1 ? 'Playbook' : 'Playbooks'}
                  </span>
                </span>
                {drafts[skill.id] && (
                  <span
                    role="img"
                    aria-label="Unsaved edits"
                    title="Unsaved edits. Save or Discard them in the Skill."
                    className="size-1.75 flex-none rounded-full bg-accent"
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <SkillEditor
        key={open.id}
        skill={open}
        working={working}
        dirty={drafts[open.id] !== undefined}
        onChange={(next) => edit(open, next)}
        onDiscard={() => drop(open.id)}
        onSaved={() => drop(open.id)}
        onDeleted={() => {
          drop(open.id);
          setAddress({ skill: null }, { replace: true });
        }}
      />
    </div>
  );
}
