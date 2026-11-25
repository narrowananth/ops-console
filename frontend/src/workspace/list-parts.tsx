import type { ReactNode } from 'react';
import { z } from 'zod';
import { useStored } from '../lib/remember';

/** The search box atop a list pane. */
export function SearchField({
  label,
  value,
  placeholder,
  title,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  title?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-neutral-600"
      >
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        aria-label={label}
        title={title}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-7.5 w-full rounded-md border border-divider bg-card pr-2.5 pl-7.5 text-xs text-text outline-none placeholder:text-neutral-600 focus:border-accent-400 focus:shadow-[0_0_0_3px_var(--color-accent-100)]"
      />
    </div>
  );
}

export type Filter<T extends string> = { value: T; label: string; count?: number; urgent?: boolean };

/** Text tabs, each with its count when above zero; an urgent tab's count is red. */
export function FilterTabs<T extends string>({
  label,
  value,
  filters,
  onChange,
}: {
  label: string;
  value: T;
  filters: Filter<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset aria-label={label} className="m-0 flex flex-none items-center gap-1 border-0 p-0">
      {filters.map((filter) => {
        const on = filter.value === value;
        const count = filter.count ?? 0;
        const hot = filter.urgent && count > 0;
        return (
          <button
            key={filter.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(filter.value)}
            className={`flex flex-none cursor-pointer items-center gap-1 rounded-md border-0 px-2.5 py-1 text-xs whitespace-nowrap transition-colors ${on ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:bg-neutral-200 hover:text-text'}`}
          >
            {filter.label}
            {count > 0 && (
              <>
                {' '}
                <span
                  className={`rounded-full px-1.25 font-mono text-[10px] leading-4 font-medium ${hot ? 'bg-accent text-white' : on ? 'bg-neutral-200 text-text' : 'text-neutral-600'}`}
                >
                  {count}
                </span>
              </>
            )}
          </button>
        );
      })}
    </fieldset>
  );
}

/** Which groups of a list the operator folded, kept in this browser. */
export function useFolded(list: string): [(group: string) => boolean, (group: string) => void] {
  const [folded, setFolded] = useStored(`workspace.${list}-folded`, z.array(z.string()), []);
  return [
    (group) => folded.includes(group),
    (group) => setFolded((now) => (now.includes(group) ? now.filter((g) => g !== group) : [...now, group])),
  ];
}

/** A group of rows under a header that folds it; the header keeps its count while folded. */
export function ListGroup({
  label,
  count,
  dot,
  folded,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  /** The tint of the header's dot, a `bg-*` class. */
  dot: string;
  folded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="px-2">
      <h3 className="m-0 pt-2">
        <button
          type="button"
          aria-label={`Fold ${label}`}
          aria-expanded={!folded}
          title={folded ? `Show ${label}` : `Fold ${label}`}
          onClick={onToggle}
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.06em] text-neutral-700 uppercase transition-colors hover:bg-neutral-200 hover:text-text"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden
            className={`flex-none text-neutral-600 transition-transform ${folded ? '-rotate-90' : ''}`}
          >
            <path
              d="M2 3.5 5 6.5 8 3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span aria-hidden className={`size-1.5 flex-none rounded-full ${dot}`} />
          {label}
          <span className="ml-auto font-mono text-[11px] font-medium tracking-normal text-neutral-600">{count}</span>
        </button>
      </h3>
      {!folded && <ul className="m-0 flex list-none flex-col gap-px p-0 pb-1">{children}</ul>}
    </section>
  );
}
