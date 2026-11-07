import { SkillKind, type SkillPack } from '@ops-console/shared';
import { useSkillPacks } from '../lib/queries';

const LOOK: Record<SkillKind, { tip: string; style: string }> = {
  [SkillKind.Builtin]: {
    tip: 'Ships with the console in a Skill pack you installed. Read-only.',
    style: 'bg-accent-100 text-accent-700',
  },
  [SkillKind.Custom]: { tip: 'A Skill you wrote. Every Session can use it.', style: 'bg-neutral-200 text-neutral-700' },
  [SkillKind.Project]: { tip: "A skill in this Repo's own folder. Read-only.", style: 'bg-ok/12 text-ok' },
};

/** The pack a Built-in skill belongs to, by its id when known and else by the skill's name, which no two packs share. */
function packOf(packs: SkillPack[] | undefined, name: string, packId?: string | null): SkillPack | undefined {
  return packs?.find((pack) => pack.id === packId || (!packId && pack.skills.some((skill) => skill.name === name)));
}

/** What a skill's badge says: the pack's name for a Built-in skill (Caveman, Ops Console), else Custom or Project. */
export function badgeLabel(
  kind: SkillKind,
  name: string,
  packs: SkillPack[] | undefined,
  packId?: string | null,
): string {
  if (kind === SkillKind.Custom) return 'Custom';
  if (kind === SkillKind.Project) return 'Project';
  return packOf(packs, name, packId)?.name ?? 'Built-in';
}

/** Gives `badgeLabel` the packs the console ships, read once for the page. */
export function useBadgeLabel(): (kind: SkillKind, name: string, packId?: string | null) => string {
  const packs = useSkillPacks().data?.items;
  return (kind, name, packId) => badgeLabel(kind, name, packs, packId);
}

/** Where a skill comes from: the name of its pack for a Built-in skill, Custom, or Project. */
export function KindBadge({ kind, name, pack }: { kind: SkillKind; name: string; pack?: string | null }) {
  const label = useBadgeLabel()(kind, name, pack);
  const look = LOOK[kind];
  return (
    <span
      title={kind === SkillKind.Builtin ? `From the ${label} pack. Read-only.` : look.tip}
      className={`inline-flex flex-none items-center rounded-full px-2 py-px text-[10px] whitespace-nowrap ${look.style}`}
    >
      {label}
    </span>
  );
}
