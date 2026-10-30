import { type Session, SessionState } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { useBranches, useCheckout } from '../lib/queries';

const RUNNING = [SessionState.Working, SessionState.WaitingApproval];

/** Why checkout is refused right now, or null. Mirrors the daemon's rule (Behavior 7). */
export function checkoutBlock(session: Session, all: Session[]): string | null {
  if (session.state !== SessionState.Idle && session.state !== SessionState.Failed) return 'This Session is running.';
  const busy = all.some((other) => other.repo_id === session.repo_id && RUNNING.includes(other.state));
  return busy ? 'A Session in this Repo is running.' : null;
}

export function BranchSwitcher({ session, all }: { session: Session; all: Session[] }) {
  const repoId = session.repo_id as string;
  const branches = useBranches(repoId);
  const checkout = useCheckout(session.id, repoId);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const block = checkoutBlock(session, all);
  const go = (branch: string, create: boolean) =>
    checkout.mutate({ branch, create }, { onSuccess: () => setOpen(false) });

  return (
    <div className="relative">
      <Button
        className="px-2.5 py-1 font-mono text-xs"
        aria-expanded={open}
        disabled={block !== null}
        title={block ?? 'Switch branch'}
        onClick={() => setOpen(!open)}
      >
        ⎇ {session.branch}
      </Button>
      {block && <span className="ml-2 text-[11px] text-neutral-700">{block}</span>}
      {checkout.isSuccess && checkout.data.stashed && (
        <span role="status" className="ml-2 text-[11px] text-accent-700">
          Uncommitted changes were stashed.
        </span>
      )}
      {checkout.isError && (
        <span role="alert" className="ml-2 text-[11px] text-accent-700">
          {checkout.error.message}
        </span>
      )}
      {open && (
        <div className="absolute z-40 mt-1 w-72 border-2 border-text bg-bg">
          <ul aria-label="Branches" className="m-0 max-h-60 list-none overflow-y-auto p-0">
            {branches.data?.map((branch) => (
              <li key={branch.name}>
                <button
                  type="button"
                  disabled={checkout.isPending}
                  aria-current={branch.name === session.branch}
                  onClick={() => go(branch.name, false)}
                  className="flex w-full cursor-pointer items-center justify-between border-0 bg-transparent px-2.5 py-1.5 text-left font-mono text-xs text-text hover:bg-neutral-200"
                >
                  <span>{branch.name}</span>
                  {branch.has_open_pr && <span className="text-[10px] text-accent-700">● open PR</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-1.5 border-t border-divider p-2">
            <input
              aria-label="New branch name"
              value={name}
              placeholder="new-branch"
              onChange={(event) => setName(event.target.value)}
              className="min-w-0 flex-1 border-[1.5px] border-text bg-bg px-1.5 py-1 font-mono text-xs text-text"
            />
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={name.trim() === '' || checkout.isPending}
              onClick={() => go(name.trim(), true)}
            >
              Create
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
