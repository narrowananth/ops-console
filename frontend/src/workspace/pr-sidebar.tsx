import type { PullRequestDetail } from '@ops-console/shared';
import type { ReactNode } from 'react';
import { useFold } from '../components/ui/fold';
import { Avatar, checksItem, ItemRow, mergeChecks, ToneMark } from './pr-meta';

/** A sidebar section under a header that folds it; the fold holds on every pull request. */
export function RailSection({
  id,
  label,
  summary,
  mark,
  children,
}: {
  /** Names the kept fold. */
  id: string;
  /** The region's name. */
  label: string;
  /** What the header says, open or folded. */
  summary: ReactNode;
  /** A mark at the header's right edge. */
  mark?: ReactNode;
  children: ReactNode;
}) {
  const [folded, toggle] = useFold(`pr-rail.${id}`);
  return (
    <section aria-label={label} className="border-b border-line py-3 last:border-b-0">
      <h3 className="m-0">
        <button
          type="button"
          aria-label={`Fold ${label}`}
          aria-expanded={!folded}
          title={folded ? 'Open' : 'Fold'}
          onClick={toggle}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1 py-1 text-left text-[13px] font-semibold text-text hover:bg-neutral-200"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden
            className={`flex-none text-neutral-600 transition-transform ${folded ? '-rotate-90' : ''}`}
          >
            <path
              d="M2 3.5 5 6.5 8 3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="min-w-0 flex-1">{summary}</span>
          {mark}
        </button>
      </h3>
      {!folded && <div className="pt-2.5 pr-1 pl-5">{children}</div>}
    </section>
  );
}

export function ChecksSection({ pr }: { pr: PullRequestDetail }) {
  const item = checksItem(pr);
  return (
    <RailSection id="checks" label="Checks" summary={item.title} mark={<ToneMark tone={item.tone} />}>
      <p className="m-0 text-xs text-neutral-700">
        {item.tip}.{' '}
        <a href={pr.url} target="_blank" rel="noreferrer" className="text-text underline">
          See them on {pr.host} ↗
        </a>
      </p>
    </RailSection>
  );
}

export function MergeChecksSection({ pr }: { pr: PullRequestDetail }) {
  const items = mergeChecks(pr);
  const passed = items.filter((item) => item.tone === 'ok').length;
  return (
    <RailSection
      id="merge-checks"
      label="Merge readiness"
      summary={`${passed} of ${items.length} merge checks passed`}
      mark={<ToneMark tone={passed === items.length ? 'ok' : items.some((i) => i.tone === 'bad') ? 'bad' : 'wait'} />}
    >
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {items.map((item) => (
          <ItemRow key={item.title} item={item} />
        ))}
      </ul>
    </RailSection>
  );
}

export function PeopleSection({ pr }: { pr: PullRequestDetail }) {
  const approvals = pr.approved_by.length;
  return (
    <RailSection
      id="people"
      label="People"
      summary={approvals === 0 ? 'No approval yet' : `${approvals} ${approvals === 1 ? 'approval' : 'approvals'}`}
    >
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
        <li className="flex items-center gap-2">
          <Avatar name={pr.author} size="sm" />
          <span className="min-w-0 truncate">{pr.author}</span>
          <span className="ml-auto text-xs text-neutral-700">author</span>
        </li>
        {pr.approved_by.map((name) => (
          <li key={name} className="flex items-center gap-2">
            <Avatar name={name} size="sm" />
            <span className="min-w-0 truncate">{name}</span>
            <span className="ml-auto text-xs text-ok">✓ approved</span>
          </li>
        ))}
        {approvals === 0 && <li className="text-xs text-neutral-700">Merge unlocks once a reviewer approves.</li>}
      </ul>
    </RailSection>
  );
}
