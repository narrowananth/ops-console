import { type Subagent, SubagentStatus } from '@ops-console/shared';
import type { ReactNode } from 'react';
import { Spinner } from '../components/ui/button';
import { Elapsed } from '../components/ui/elapsed';
import { BranchIcon, SparkleIcon } from '../components/ui/icons';
import { HoverCard } from '../workspace/session-hover-card';

/** What a subagent's state is called wherever the console shows one. */
export const SUBAGENT_WORD: Record<SubagentStatus, string> = {
  [SubagentStatus.Working]: 'Running',
  [SubagentStatus.Done]: 'Done',
  [SubagentStatus.Failed]: 'Failed',
  [SubagentStatus.Stopped]: 'Stopped',
};

/** `claude-sonnet-5-5` as `Sonnet 5.5`; an id of another shape shows as it is. */
export function modelName(id: string): string {
  const found = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  const family = found?.[1];
  if (!found || !family) return id;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${found[2]}.${found[3]}`;
}

export const isRunning = (one: Subagent) => one.status === SubagentStatus.Working;

/** A subagent's mark: a spark in a ring, with a blue dot while it runs. */
export function SubagentAvatar({ running, className = '' }: { running: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={`relative flex size-7 flex-none items-center justify-center rounded-full border border-line bg-card text-neutral-700 [&>svg]:size-3.5 ${className}`}
    >
      <SparkleIcon />
      {running && <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-card bg-info" />}
    </span>
  );
}

/** The state word, blue and turning while it runs, with its time when `withTime`. */
export function SubagentStatusLine({ subagent, withTime = false }: { subagent: Subagent; withTime?: boolean }) {
  const running = isRunning(subagent);
  return (
    <span className={`flex items-center gap-1.5 ${running ? 'text-info' : 'text-neutral-700'}`}>
      {running && <Spinner />}
      {SUBAGENT_WORD[subagent.status]}
      {withTime && (
        <Elapsed from={subagent.started_at} to={subagent.finished_at} running={running} className="text-current" />
      )}
    </span>
  );
}

/** What the card says of a subagent: title, model, state with its time, and the branch of the Session it works in. */
function SubagentCard({ subagent, branch }: { subagent: Subagent; branch: string | null }) {
  return (
    <>
      <div className="text-[13px] leading-snug font-medium break-words">{subagent.description}</div>
      {subagent.model && <div className="text-neutral-800">{modelName(subagent.model)}</div>}
      <SubagentStatusLine subagent={subagent} withTime />
      {branch && (
        <div className="flex min-w-0 items-center gap-2 text-neutral-800">
          <span aria-hidden className="size-3.5 flex-none text-neutral-600 [&>svg]:size-3.5">
            <BranchIcon />
          </span>
          <span className="min-w-0 truncate">{branch}</span>
        </div>
      )}
    </>
  );
}

/** Opens the subagent's card beside `children`, which must be one element: the card sits next to it. */
export function WithSubagentCard({
  subagent,
  branch,
  children,
}: {
  subagent: Subagent;
  branch: string | null;
  children: ReactNode;
}) {
  return <HoverCard card={() => <SubagentCard subagent={subagent} branch={branch} />}>{children}</HoverCard>;
}
