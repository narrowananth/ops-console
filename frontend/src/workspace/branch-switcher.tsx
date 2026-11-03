import { type Repo, type Session, SessionState } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { item, menu } from '../components/ui/item';
import { useBranches, useCheckout } from '../lib/queries';
import { ascending } from '../lib/sort';

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
        title={
          block ??
          `Switch branch. ${dirty ? 'Changed: uncommitted edits are stashed before switching.' : 'Clean: no uncommitted edits.'}`
        }
        onClick={() => setOpen(!open)}
        className={`flex max-w-70 items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-text transition-colors enabled:cursor-pointer enabled:hover:bg-neutral-200 ${
          open ? 'border-divider bg-neutral-200' : 'border-line bg-card'
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
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="flex-none text-neutral-600">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
      </button>
      {checkout.isSuccess && checkout.data.stashed && (
        <span role="status" className="ml-2 text-xs text-accent-700">
          Uncommitted changes were stashed.
        </span>
      )}
      {checkout.isError && (
        <span role="alert" className="ml-2 text-xs text-accent-700">
          {checkout.error.message}
        </span>
      )}
      {open && (
        <div className={`absolute bottom-[calc(100%+6px)] left-0 z-51 w-80 ${menu}`}>
          <div className="flex items-center gap-2 px-2.5 pt-1 pb-2">
            <span className="flex-1 text-xs font-semibold">Branches in {repo?.name ?? 'this Repo'}</span>
            {repo && <span className="truncate font-mono text-xs text-neutral-700">{repo.path}</span>}
          </div>
          <ul aria-label="Branches" className="m-0 flex max-h-60 list-none flex-col gap-0.5 overflow-y-auto p-0">
            {ascending(branches.data ?? [], (branch) => branch.name).map((branch) => {
              const current = branch.name === session.branch;
              return (
                <li key={branch.name}>
                  <button
                    type="button"
                    disabled={checkout.isPending}
                    aria-current={current}
                    onClick={() => (current ? setOpen(false) : go(branch.name, false))}
                    className={`flex w-full items-center gap-2 px-2.5 py-2 font-mono text-xs ${item(current)} ${current ? 'font-semibold' : ''}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                    {branch.has_open_pr && (
                      <span
                        title="This branch has an open pull request"
                        className="rounded-full bg-neutral-200 px-1.5 font-sans text-xs whitespace-nowrap text-neutral-700"
                      >
                        open PR
                      </span>
                    )}
                    <span aria-hidden className={`w-3 flex-none text-accent ${current ? '' : 'invisible'}`}>
                      ✓
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-1.5 flex gap-1.5 border-t border-line px-1 pt-2">
            <input
              aria-label="New branch name"
              value={name}
              placeholder="New branch from current"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim() !== '') go(name.trim(), true);
              }}
              className="min-w-0 flex-1 border border-divider bg-card px-2.5 py-1.5 font-mono text-xs text-text"
            />
            <Button
              className="px-2.5 py-1.25 text-xs"
              title="Make a new branch from the current one and switch this Session to it"
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
