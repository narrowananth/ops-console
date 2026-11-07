import { BUILTIN_ID_PREFIX, type Skill, SkillKind } from '@ops-console/shared';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { useCreateSkill, useSkills } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { ascending } from '../lib/sort';
import { DiscoverView } from './discover-view';
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

type Tab = 'discover' | 'yours';

/**
 * The tab the page shows: Discover first. Yours when the address asks for it, or names a Custom Skill, which a link from
 * a Playbook or a job does; a pack's skill opens in Discover.
 */
function useSkillsTab(): [Tab, (next: Tab) => void] {
  const [address, setAddress] = useAddress('tab', 'skill');
  const tab: Tab =
    address.tab === 'yours' || (address.skill !== null && !address.skill.startsWith(BUILTIN_ID_PREFIX))
      ? 'yours'
      : 'discover';
  return [tab, (next) => setAddress({ tab: next === 'yours' ? 'yours' : null, skill: null })];
}

/** In the page header, on Yours only: Discover has nothing to write. */
export function NewSkillButton() {
  const create = useNewSkill();
  const [tab] = useSkillsTab();
  if (tab !== 'yours') return null;
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

/** Discover and Yours, as tabs over the page's list. */
function Tabs({ tab, onTab }: { tab: Tab; onTab: (next: Tab) => void }) {
  return (
    <div role="tablist" aria-label="Skills" className="mx-3 mt-3 flex gap-0.5 rounded-lg bg-neutral-200 p-0.75">
      {(['discover', 'yours'] as const).map((name) => (
        <button
          key={name}
          type="button"
          role="tab"
          aria-selected={tab === name}
          onClick={() => onTab(name)}
          className={`flex-1 cursor-pointer rounded-md border-0 px-0 py-1 text-xs ${tab === name ? 'bg-card font-bold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
        >
          {name === 'yours' ? 'Yours' : 'Discover'}
        </button>
      ))}
    </div>
  );
}

export function SkillsView() {
  const [tab, pick] = useSkillsTab();
  if (tab === 'discover') {
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <DiscoverView tabs={<Tabs tab={tab} onTab={pick} />} />
      </div>
    );
  }
  return <YoursView onTab={pick} />;
}

function YoursView({ onTab }: { onTab: (next: Tab) => void }) {
  const list = useSkills();
  const [address, setAddress] = useAddress('skill', 'tab');
  const { drafts, edit, drop } = useDrafts();

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
  // Yours holds the Skills the operator wrote; a pack's skills are read in Discover.
  const items = ascending(
    list.data.items.filter((skill) => skill.kind === SkillKind.Custom),
    (skill) => skill.name,
  );
  const open = items.find((skill) => skill.id === address.skill) ?? items[0];
  // With none the page keeps its tabs and says so; the header's New Skill starts the first.
  if (!open)
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <aside aria-label="Skills" className="flex w-80 flex-none flex-col overflow-y-auto border-r border-line">
          <Tabs tab="yours" onTab={onTab} />
          <p className="m-0 px-5 py-4 text-[13px] text-neutral-700">No Skills yet.</p>
        </aside>
      </div>
    );
  const working: Draft = drafts[open.id] ?? draftOf(open);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside aria-label="Skills" className="flex w-80 flex-none flex-col overflow-y-auto border-r border-line">
        <Tabs tab="yours" onTab={onTab} />
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 px-3 py-3">
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
          // Dropping the skill from the address keeps the page on Yours.
          setAddress({ skill: null, tab: 'yours' }, { replace: true });
        }}
      />
    </div>
  );
}
