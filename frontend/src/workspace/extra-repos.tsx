import type { Repo, Session } from '@ops-console/shared';
import { useState } from 'react';
import { FolderIcon } from '../components/ui/icons';
import { item, menu } from '../components/ui/item';
import { useUpdateSession } from '../lib/queries';
import { ascending } from '../lib/sort';
import { useAnchoredMenu } from './anchored-menu';

/**
 * The composer's Repos icon, beside Attach: other Repos the operator opens to this Session, so its agent reads, edits and commits in
 * their checkouts as in its own. The choice is the operator's, made here, and applies from the Session's next run.
 */
export function ExtraRepos({ session, repos }: { session: Session; repos: Repo[] }) {
  const update = useUpdateSession(session.id);
  const [query, setQuery] = useState('');
  const { trigger, open, place, close, toggle } = useAnchoredMenu('data-extra-repos');
  const picked = session.extra_repo_ids;
  const others = ascending(
    repos.filter((repo) => repo.id !== session.repo_id),
    (repo) => repo.name,
  );
  // `others` is A to Z, so the choice reads the same way.
  const choice = ['this one', ...others.filter((repo) => picked.includes(repo.id)).map((repo) => repo.name)].join(', ');
  const needle = query.trim().toLowerCase();
  const shown = needle ? others.filter((repo) => repo.name.toLowerCase().includes(needle)) : others;

  if (others.length === 0) return null;

  const flip = (id: string) =>
    update.mutate({ extra_repo_ids: picked.includes(id) ? picked.filter((one) => one !== id) : [...picked, id] });

  return (
    <div className="relative flex-none">
      {open && (
        <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-50 cursor-default" onClick={close} />
      )}
      <button
        ref={trigger}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Repos: ${choice}`}
        title={`Repos: ${choice}. Other Repos this Session's agent may read, edit and commit in, as in its own. Applies from its next run.`}
        onClick={() => toggle(() => setQuery(''))}
        className={`relative flex size-9 cursor-pointer items-center justify-center rounded-full border text-neutral-700 hover:border-accent-300 hover:text-text ${
          open
            ? 'border-divider bg-neutral-200'
            : picked.length > 0
              ? 'border-accent-300 bg-accent-100'
              : 'border-line bg-card'
        }`}
      >
        <FolderIcon size={19} />
        {picked.length > 0 && (
          <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-semibold text-white">
            {picked.length}
          </span>
        )}
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
