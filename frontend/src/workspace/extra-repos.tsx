import type { Repo, Session } from '@ops-console/shared';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { item, menu } from '../components/ui/item';
import { useUpdateSession } from '../lib/queries';
import { ascending } from '../lib/sort';

/**
 * The composer's Repos chip: other Repos the operator opens to this Session, so its agent reads, edits and commits in
 * their checkouts as in its own. The choice is the operator's, made here, and applies from the Session's next run.
 */
export function ExtraRepos({ session, repos }: { session: Session; repos: Repo[] }) {
  const update = useUpdateSession(session.id);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const open = place !== null;
  const picked = session.extra_repo_ids;
  const others = ascending(
    repos.filter((repo) => repo.id !== session.repo_id),
    (repo) => repo.name,
  );
  const needle = query.trim().toLowerCase();
  const shown = needle ? others.filter((repo) => repo.name.toLowerCase().includes(needle)) : others;

  useEffect(() => {
    if (!open) return;
    const close = () => setPlace(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      trigger.current?.focus();
    };
    // A scroll anywhere but inside the list would leave it floating away from its button.
    const scroll = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest('[data-extra-repos]'))) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (others.length === 0) return null;

  const toggle = () => {
    const box = trigger.current?.getBoundingClientRect();
    if (open || !box) return setPlace(null);
    setQuery('');
    setPlace({ bottom: window.innerHeight - box.top + 6, left: box.left });
  };
  const flip = (id: string) =>
    update.mutate({ extra_repo_ids: picked.includes(id) ? picked.filter((one) => one !== id) : [...picked, id] });

  return (
    <div className="relative flex-none">
      {open && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-50 cursor-default"
          onClick={() => setPlace(null)}
        />
      )}
      <button
        ref={trigger}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Other Repos"
        title="Other Repos this Session's agent may read, edit and commit in, as in its own. Applies from its next run."
        onClick={toggle}
        className={`flex cursor-pointer items-center gap-1.25 rounded-full border px-2.5 py-1 text-xs text-text transition-colors hover:bg-neutral-200 ${
          open ? 'border-divider bg-neutral-200' : 'border-transparent bg-transparent'
        }`}
      >
        <span className="text-neutral-700">Repos</span>
        <span className="font-semibold">{picked.length === 0 ? 'this one' : `+${picked.length}`}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
          className={`flex-none text-neutral-600 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {place && (
        <div
          data-extra-repos
          style={place}
          className={`fixed z-51 max-h-80 w-72 max-w-[calc(100vw-16px)] overflow-auto ${menu}`}
        >
          <div className="px-2.5 pt-1.5 pb-1 text-xs font-semibold tracking-[0.06em] text-neutral-600 uppercase">
            Also open to this session
          </div>
          <p className="px-2.5 pb-1.5 text-xs text-neutral-700">
            The agent can read, edit and commit in the ticked Repos. It never pushes.
          </p>
          <input
            type="search"
            aria-label="Search Repos"
            placeholder="Search"
            value={query}
            // biome-ignore lint/a11y/noAutofocus: the list opens to be searched
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            className="sticky top-0 z-10 mb-1 block w-full border border-divider bg-bg px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-accent-400"
          />
          {shown.length === 0 && <div className="px-2.5 py-2 text-xs text-neutral-700">No match</div>}
          {shown.map((repo) => {
            const on = picked.includes(repo.id);
            return (
              <button
                key={repo.id}
                type="button"
                aria-pressed={on}
                onClick={() => flip(repo.id)}
                className={`flex w-full items-center gap-2.5 px-2.5 py-2 outline-none focus-visible:bg-neutral-200 ${item(on)}`}
              >
                <span className={`min-w-0 flex-1 truncate text-[13px] ${on ? 'font-semibold' : ''}`}>{repo.name}</span>
                <span aria-hidden className={`w-3 flex-none text-xs ${on ? 'text-accent' : 'invisible'}`}>
                  ✓
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
