import { type KeyboardEvent, type ReactNode, useRef } from 'react';

export type PrTab = { id: string; label: string; icon: ReactNode; count?: number };

/** The pull request's tabs, in the segmented look of Accounts and Usage; arrow keys, Home and End move between them. */
export function PrTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: (PrTab & { id: T })[];
  value: T;
  onChange: (id: T) => void;
}) {
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((tab) => tab.id === value);
    const to =
      event.key === 'ArrowRight'
        ? (at + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : -1;
    const next = tabs[to];
    if (!next) return;
    event.preventDefault();
    onChange(next.id);
    buttons.current[next.id]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Pull request"
      onKeyDown={onKeyDown}
      className="flex w-max gap-1 rounded-xl bg-neutral-200 p-1"
    >
      {tabs.map((tab) => {
        const on = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              buttons.current[tab.id] = node;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border-0 px-4 py-1.5 text-[13px] transition-colors ${
              on
                ? 'bg-card font-bold text-text shadow-md'
                : 'bg-transparent font-semibold text-neutral-700 hover:bg-card/60 hover:text-text'
            }`}
          >
            <span className={on ? 'text-accent' : ''}>{tab.icon}</span>
            {tab.label}
            {tab.count !== undefined && (
              <span className="rounded-full bg-neutral-300 px-1.75 py-px font-mono text-[10px] font-semibold text-neutral-800">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function OverviewIcon() {
  return (
    <Icon>
      <path d="M4 5h16M4 12h16M4 19h10" />
    </Icon>
  );
}

export function FilesIcon() {
  return (
    <Icon>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M12 10v6" />
    </Icon>
  );
}

export function CommitsIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3v5.5M12 15.5V21" />
    </Icon>
  );
}
