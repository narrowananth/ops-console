import type { SkillMenuItem } from '@ops-console/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSkillMenu } from '../lib/queries';
import { KindBadge } from '../skills/kind-badge';

/** `/` and the name so far: the menu is open while the message is one word that starts with a slash. */
const OPEN = /^\/[^\s]*$/;

/** A row's key: two skills of one name differ by kind (a Project `pr` and an Ops Console `pr`). */
const keyOf = (item: SkillMenuItem) => `${item.kind}:${item.name}`;

/**
 * The `/` menu above a Session's composer: Ops Console, Custom and, in a Repo, Project skills, read each time it opens.
 * Arrows move, Enter or Tab picks, Escape closes until the text changes.
 */
export function useSkillMenuFor(
  sessionId: string,
  text: string,
  enabled: boolean,
  onPick: (item: SkillMenuItem) => void,
): { onKey: (event: KeyboardEvent) => boolean; menu: ReactNode } {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const open = enabled && OPEN.test(text) && dismissed !== text;
  const q = text.slice(1);
  const query = useSkillMenu(sessionId, q, open);
  const items = query.data?.items ?? [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: the pick goes back to the first row whenever the text changes
  useEffect(() => setActive(0), [text]);

  const onKey = (event: KeyboardEvent): boolean => {
    if (!open || event.isComposing) return false;
    if (event.key === 'Escape') {
      setDismissed(text);
      return true;
    }
    if (items.length === 0) return false;
    if (event.key === 'ArrowDown') setActive((now) => (now + 1) % items.length);
    else if (event.key === 'ArrowUp') setActive((now) => (now - 1 + items.length) % items.length);
    else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      const chosen = items[Math.min(active, items.length - 1)];
      if (chosen) onPick(chosen);
    } else return false;
    return true;
  };

  if (!open) return { onKey, menu: null };
  return {
    onKey,
    menu: (
      <div
        role="listbox"
        aria-label="Skills"
        className="absolute right-0 bottom-[calc(100%+6px)] left-0 z-20 flex max-h-72 flex-col overflow-y-auto rounded-lg border border-line bg-card p-1.5 shadow-lg"
      >
        <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-neutral-700 uppercase">
          Skills
        </div>
        {query.isError ? (
          <p role="alert" className="m-0 px-2.5 py-2 text-xs text-accent-700">
            Could not read skills: {query.error.message}
          </p>
        ) : query.data === undefined ? (
          <p className="m-0 px-2.5 py-2 text-xs text-neutral-700">Reading skills…</p>
        ) : items.length === 0 ? (
          <p className="m-0 px-2.5 py-2 text-xs text-neutral-700">
            {q === '' ? (
              <>
                No skills yet. Install some from <Link to="/skills?tab=discover">Discover</Link>.
              </>
            ) : (
              'No skills match'
            )}
          </p>
        ) : (
          items.map((entry, index) => (
            <div
              key={keyOf(entry)}
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              // Keeps the focus in the message while a row is clicked.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(entry)}
              onKeyDown={() => undefined}
              onMouseEnter={() => setActive(index)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] ${index === active ? 'bg-accent-100 text-accent-900' : 'hover:bg-neutral-200'}`}
            >
              <span className="flex-none font-mono font-semibold">/{entry.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-700">{entry.description}</span>
              <KindBadge kind={entry.kind} name={entry.name} pack={entry.pack} />
            </div>
          ))
        )}
        <p className="m-0 mt-1 border-t border-line px-2.5 pt-1.5 text-[11px] text-neutral-700">
          Enter picks, Esc closes. What you type after the name is the task.
        </p>
      </div>
    ),
  };
}
