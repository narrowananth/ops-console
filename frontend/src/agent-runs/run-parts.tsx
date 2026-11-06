import type { ReactNode } from 'react';

export function Heading({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <h3 className="m-0 mb-2 flex items-baseline gap-2 text-[13px] font-bold">
      {children}
      {note && <small className="text-[11px] font-normal text-neutral-700">{note}</small>}
    </h3>
  );
}

export function Bulb({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`size-4 flex-none ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.4 1 2.5h6c0-1.1.3-1.8 1-2.5A6 6 0 0 0 12 3z" />
    </svg>
  );
}

/** A spinning ring for a lane or step that goes. */
export function Ring({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`size-3 flex-none animate-spin ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

export const shown = (summary: string) => (summary.startsWith('$ ') ? summary.slice(2) : summary);
export const baseName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
