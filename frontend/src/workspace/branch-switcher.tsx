import { type Repo, type Session, SessionState } from '@ops-console/shared';
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

/** The composer's branch chip: the Session's branch and whether the Repo has uncommitted changes on it. */
export function BranchSwitcher({ session, all, repo }: { session: Session; all: Session[]; repo?: Repo }) {
  const repoId = session.repo_id as string;
  const branches = useBranches(repoId);
  const checkout = useCheckout(session.id, repoId);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const block = checkoutBlock(session, all);
  const dirty = repo?.branch === session.branch && repo.dirty;
  const go = (branch: string, create: boolean) =>
    checkout.mutate({ branch, create }, { onSuccess: () => setOpen(false) });

  return (
    <div className="relative flex items-center">
      {open && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-50 cursor-default"
          onClick={() => setOpen(false)}
        />
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Branch ${session.branch}`}
        disabled={block !== null}
        title={block ?? 'Switch branch'}
        onClick={() => setOpen(!open)}
        className={`flex max-w-70 items-center gap-1.5 border bg-transparent px-2.25 py-1 text-xs text-text enabled:cursor-pointer ${
          open ? 'border-text' : 'border-divider'
        }`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="6" cy="5" r="2" />
          <circle cx="6" cy="19" r="2" />
          <circle cx="18" cy="8" r="2" />
          <path d="M6 7v10M18 10c0 4-6 3-12 7" />
        </svg>
        <span className="truncate font-mono">{session.branch}</span>
        <span className={`whitespace-nowrap ${dirty ? 'text-accent-700' : 'text-neutral-600'}`}>
          {dirty ? 'changed' : 'clean'}
        </span>
        {block === null && (
          <span className="text-[9px] text-neutral-600" aria-hidden>
            ▼
          </span>
        )}
      </button>
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
        <div className="absolute bottom-[calc(100%+6px)] left-0 z-51 w-80 border-2 border-text bg-bg shadow-lg">
          <div className="flex items-center gap-2 border-b border-divider px-3 py-2">
            <span className="flex-1 text-xs font-extrabold">Branches in {repo?.name ?? 'this Repo'}</span>
            {repo && <span className="truncate font-mono text-[11px] text-neutral-700">{repo.path}</span>}
          </div>
          <ul aria-label="Branches" className="m-0 max-h-60 list-none overflow-y-auto p-0">
            {branches.data?.map((branch) => {
              const current = branch.name === session.branch;
              return (
                <li key={branch.name}>
                  <button
                    type="button"
                    disabled={checkout.isPending}
                    aria-current={current}
                    onClick={() => (current ? setOpen(false) : go(branch.name, false))}
                    className={`flex w-full cursor-pointer items-center gap-2 border-0 border-l-3 px-3 py-1.75 text-left font-mono text-xs text-text hover:bg-neutral-200 ${
                      current ? 'border-l-accent bg-neutral-200 font-extrabold' : 'border-l-transparent bg-transparent'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                    {branch.has_open_pr && (
                      <span className="font-sans text-[10px] whitespace-nowrap text-neutral-700">open PR</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex gap-1.5 border-t border-divider px-3 py-2">
            <input
              aria-label="New branch name"
              value={name}
              placeholder="New branch from current"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim() !== '') go(name.trim(), true);
              }}
              className="min-w-0 flex-1 border-[1.5px] border-text bg-bg px-2 py-1.25 font-mono text-xs text-text"
            />
            <Button
              className="px-2.5 py-1.25 text-xs"
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
