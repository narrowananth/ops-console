import type { ReactNode } from 'react';
import { useState } from 'react';
import { z } from 'zod';
import { PanelRail, PanelToggle, RAIL_BUTTON } from '../components/ui/side-panel';
import { readStored, useStored } from '../lib/remember';

/**
 * A page with its list on the left and the picked item on the right. The list folds to a strip, and each page
 * remembers its own fold, falling back to the old shared one.
 */
export function ListPage({
  page,
  title,
  tip,
  icon,
  badge = 0,
  list,
  children,
}: {
  page: 'sessions' | 'pull-requests';
  title: string;
  tip: string;
  icon: ReactNode;
  /** Shown on the folded strip's button: how many items wait on the operator. */
  badge?: number;
  list: ReactNode;
  children: ReactNode;
}) {
  const [before] = useState(() => readStored('workspace.pane-collapsed', z.boolean(), false));
  const [collapsed, setCollapsed] = useStored(`${page}.pane-collapsed`, z.boolean(), before);
  const label = badge > 0 ? `${title}, ${badge} waiting on you` : title;
  return (
    <>
      {collapsed ? (
        <PanelRail label={`${title} list`}>
          <PanelToggle open={false} onToggle={() => setCollapsed(false)} />
          <span aria-hidden className="my-1 h-px w-6 bg-line" />
          <button
            type="button"
            aria-label={label}
            title={badge > 0 ? `${title}: ${badge} waiting on you` : title}
            onClick={() => setCollapsed(false)}
            className={`relative bg-card text-text shadow-sm ${RAIL_BUTTON}`}
          >
            {icon}
            {badge > 0 && (
              <span
                aria-hidden
                className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-accent px-1 text-center font-mono text-[9px] leading-3.5 font-semibold text-white"
              >
                {badge}
              </span>
            )}
          </button>
        </PanelRail>
      ) : (
        <aside className="flex w-80 flex-none flex-col border-r border-line">
          <div className="mx-3 mt-3.5 mb-2 flex items-center gap-1.5">
            <h2 title={tip} className="m-0 flex-1 text-[15px]">
              {title}
            </h2>
            <PanelToggle open onToggle={() => setCollapsed(true)} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{list}</div>
        </aside>
      )}
      <section className="min-w-0 flex-1 overflow-y-auto">{children}</section>
    </>
  );
}

export function SessionsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
    </svg>
  );
}

export function PullRequestIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6" />
    </svg>
  );
}
