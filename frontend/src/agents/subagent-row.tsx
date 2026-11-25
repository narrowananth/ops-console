import { type Subagent, SubagentStatus } from '@ops-console/shared';
import { useState } from 'react';
import { Elapsed } from '../components/ui/elapsed';
import { ChevronIcon } from '../components/ui/icons';
import { isRunning, SUBAGENT_WORD, SubagentAvatar, SubagentStatusLine, WithSubagentCard } from './subagent-look';

const SHOWN_AVATARS = 3;

/** `2 working`, `1 done`, or both; one that failed or stopped is counted by that word. */
function subLabel(subagents: Subagent[]): string {
  return [SubagentStatus.Working, SubagentStatus.Done, SubagentStatus.Failed, SubagentStatus.Stopped]
    .map((status) => ({ status, count: subagents.filter((one) => one.status === status).length }))
    .filter(({ count }) => count > 0)
    .map(
      ({ status, count }) =>
        `${count} ${status === SubagentStatus.Working ? 'working' : SUBAGENT_WORD[status].toLowerCase()}`,
    )
    .join(' · ');
}

/** When the last subagent finished, or null while one still runs. */
function endOf(subagents: Subagent[]): string | null {
  if (subagents.some(isRunning)) return null;
  return subagents.reduce<string | null>(
    (late, one) => (one.finished_at !== null && (late === null || one.finished_at > late) ? one.finished_at : late),
    null,
  );
}

/**
 * The row that ends a turn which started subagents: a stack of their avatars, how many, how they stand and the time
 * since the first started. Opened, it lists each one, with a card on hover.
 */
export function SubagentRow({ subagents, branch }: { subagents: Subagent[]; branch: string | null }) {
  const [open, setOpen] = useState(false);
  const first = subagents.map((one) => one.started_at).sort()[0];
  if (first === undefined) return null;
  const working = subagents.some(isRunning);
  const hidden = subagents.length - SHOWN_AVATARS;
  return (
    <li aria-label="Subagents" className="mx-5 my-2 flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-line bg-card px-3 py-2 text-left text-sm text-text hover:bg-neutral-200"
      >
        <span className="flex flex-none items-center">
          {subagents.slice(0, SHOWN_AVATARS).map((one, at) => (
            <SubagentAvatar key={one.id} running={false} className={at > 0 ? '-ml-2' : ''} />
          ))}
          {hidden > 0 && <span className="ml-1 text-xs text-neutral-700">+{hidden}</span>}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <b className="truncate">{subagents.length === 1 ? '1 subagent' : `${subagents.length} subagents`}</b>
          <span className={`text-xs ${working ? 'text-info' : 'text-neutral-700'}`}>{subLabel(subagents)}</span>
        </span>
        <Elapsed from={first} to={endOf(subagents)} running={working} className="flex-none" />
        <ChevronIcon open={open} />
      </button>
      {open && (
        <ul className="m-0 mt-1.5 flex list-none flex-col overflow-hidden rounded-xl border border-line bg-card p-0">
          {subagents.map((one) => (
            <li key={one.id} className="border-t border-line first:border-t-0">
              <WithSubagentCard subagent={one} branch={branch}>
                <div className="flex items-center gap-3 px-3 py-2 text-sm">
                  <SubagentAvatar running={isRunning(one)} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{one.description}</span>
                    <span className="text-xs">
                      <SubagentStatusLine subagent={one} />
                    </span>
                  </span>
                  <Elapsed from={one.started_at} to={one.finished_at} running={isRunning(one)} className="flex-none" />
                </div>
              </WithSubagentCard>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
