import { BUILTIN_ID_PREFIX, type SkillPack } from '@ops-console/shared';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spinner } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { useInstallPack, useSkillPacks, useSkills } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { ascending } from '../lib/sort';
import { packHolders, UninstallPackDialog } from './uninstall-pack';

function PackState({ pack }: { pack: SkillPack }) {
  const text = pack.installed ? 'Installed' : 'Install';
  return (
    <span
      className={`flex-none rounded-full px-2 py-px text-[10px] ${pack.installed ? 'bg-ok/12 text-ok' : 'bg-neutral-200 text-neutral-700'}`}
    >
      {text}
    </span>
  );
}

/** Discover: the Skill packs the console ships, and the open pack with its skills, Install and Uninstall. */
export function DiscoverView({ tabs }: { tabs: ReactNode }) {
  const packs = useSkillPacks();
  const [address, setAddress] = useAddress('pack', 'skill');
  // A link to one skill of a pack names the skill; its pack opens.
  const linked = address.skill?.startsWith(BUILTIN_ID_PREFIX) ? address.skill.slice(BUILTIN_ID_PREFIX.length) : null;
  const linkedPack = linked?.split('/', 1)[0];

  const aside = (body: ReactNode) => (
    <aside aria-label="Skill packs" className="flex w-80 flex-none flex-col overflow-y-auto border-r border-line">
      {tabs}
      {body}
    </aside>
  );
  if (packs.isPending) return aside(<Empty>Reading Skill packs…</Empty>);
  if (packs.isError)
    return aside(
      <Empty>
        Could not read Skill packs: {packs.error.message}{' '}
        <Button className="ml-2 px-2.5 py-1 text-xs" onClick={() => void packs.refetch()}>
          Retry
        </Button>
      </Empty>,
    );
  const items = ascending(packs.data.items, (pack) => pack.name);
  const open = items.find((pack) => pack.id === (linkedPack ?? address.pack)) ?? items[0];
  if (!open) return aside(<Empty>No Skill packs ship with this version.</Empty>);

  return (
    <>
      {aside(
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 px-3 py-3">
          {items.map((pack) => (
            <li key={pack.id}>
              <button
                type="button"
                aria-current={pack.id === open.id ? 'true' : undefined}
                onClick={() => setAddress({ pack: pack.id, skill: null })}
                className={`flex w-full items-center gap-2 px-2.5 py-2 text-[13px] ${item(pack.id === open.id)}`}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold">{pack.name}</span>
                  <span className="truncate text-xs text-neutral-700">{pack.skills.length} skills</span>
                </span>
                <PackState pack={pack} />
              </button>
            </li>
          ))}
        </ul>,
      )}
      <PackView
        key={open.id}
        pack={open}
        openSkill={address.skill}
        onOpenSkill={(id) => setAddress({ pack: open.id, skill: id })}
      />
    </>
  );
}

function PackView({
  pack,
  openSkill,
  onOpenSkill,
}: {
  pack: SkillPack;
  /** The id of the skill shown open, or null. */
  openSkill: string | null;
  onOpenSkill: (id: string | null) => void;
}) {
  const install = useInstallPack();
  const yours = useSkills();
  const [asking, setAsking] = useState(false);
  const holders = packHolders(yours.data?.items ?? [], pack.id);

  return (
    <section aria-label={pack.name} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full max-w-180 flex-col gap-5 px-7 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 min-w-0 flex-1 truncate text-lg font-semibold">{pack.name}</h2>
          <PackState pack={pack} />
          {pack.installed ? (
            <Button
              className="px-2.5 py-1 text-xs text-accent-700"
              title="Remove every skill of this pack from the Playbooks that hold them and from the / menu. Asks first."
              onClick={() => setAsking(true)}
            >
              Uninstall
            </Button>
          ) : (
            <Button
              variant="primary"
              className="px-2.5 py-1 text-xs"
              disabled={install.isPending}
              title={`Make all ${pack.skills.length} skills available to Playbooks and the / menu`}
              onClick={() => install.mutate(pack.id)}
            >
              {install.isPending && <Spinner />}
              Install
            </Button>
          )}
        </div>
        {install.error && (
          <p role="alert" className="m-0 text-xs text-accent-700">
            {install.error.message}
          </p>
        )}
        {asking && (
          <UninstallPackDialog
            packId={pack.id}
            name={pack.name}
            skillCount={pack.skills.length}
            holders={holders}
            onDone={() => setAsking(false)}
          />
        )}
        <p className="m-0 -mt-3 text-[13px] text-neutral-700">{pack.description}</p>
        <ul
          aria-label={`${pack.name} skills`}
          className="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-line bg-card p-0"
        >
          {ascending(pack.skills, (skill) => skill.name).map((skill) => {
            const id = `${BUILTIN_ID_PREFIX}${pack.id}/${skill.name}`;
            const opened = openSkill === id;
            const held = ascending(
              (yours.data?.items ?? []).find((candidate) => candidate.id === id)?.playbooks ?? [],
              (playbook) => playbook.name,
            );
            return (
              <li key={skill.name} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  aria-expanded={opened}
                  title="Read this skill's text"
                  onClick={() => onOpenSkill(opened ? null : id)}
                  className="flex w-full cursor-pointer flex-col gap-0.5 border-0 bg-transparent px-3.5 py-2 text-left hover:bg-neutral-200"
                >
                  <span className="font-mono text-[13px] font-semibold">{skill.name}</span>
                  <span className="text-xs text-neutral-700">{skill.description}</span>
                </button>
                {opened && (
                  <div className="flex flex-col gap-3 px-3.5 pb-3">
                    <pre className="m-0 max-h-[50vh] overflow-auto rounded-lg border border-line bg-surface px-3.5 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                      {skill.instructions}
                    </pre>
                    <p className="m-0 text-xs text-neutral-700">
                      Read-only: the console keeps this text and updates it with the console.
                      {held.length === 0 ? ' No Playbook holds it.' : ' Held by '}
                      {held.map((playbook, index) => (
                        <span key={playbook.id}>
                          {index > 0 && ', '}
                          <Link to={`/playbooks?playbook=${encodeURIComponent(playbook.id)}`}>{playbook.name}</Link>
                        </span>
                      ))}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="m-0 text-xs text-neutral-700">
          {pack.installed
            ? `Uninstall removes all ${pack.skills.length}.`
            : `Install makes all ${pack.skills.length} available to Playbooks and the / menu.`}
        </p>
      </div>
    </section>
  );
}
