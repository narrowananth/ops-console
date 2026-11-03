import type { ReactNode } from 'react';

/** A button on a folded panel's rail: square, the icon in its middle. */
export const RAIL_BUTTON =
  'flex size-10 flex-none cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-neutral-700 hover:bg-neutral-200 hover:text-text focus-visible:outline-2 focus-visible:outline-accent';

/**
 * The arrow that folds a side panel to its rail, and opens it again. Beside a switch or a range picker it takes that
 * control's height and box, so the two read as one row.
 */
export function PanelToggle({
  open,
  onToggle,
  panel = 'side panel',
}: {
  open: boolean;
  onToggle: () => void;
  panel?: string;
}) {
  const label = `${open ? 'Collapse' : 'Open'} the ${panel}`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={onToggle}
      className={`flex flex-none cursor-pointer items-center justify-center rounded-lg border-0 bg-neutral-200 text-neutral-700 hover:bg-neutral-300 hover:text-text focus-visible:outline-2 focus-visible:outline-accent ${open ? 'aspect-square self-stretch' : 'size-10'}`}
    >
      <PanelIcon open={open} />
    </button>
  );
}

/** A side panel folded to a strip: the arrow that opens it, then the panel's own buttons. */
export function PanelRail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className="flex w-14 flex-none flex-col items-center gap-1.5 border-r border-line pt-3.5">
      {children}
    </nav>
  );
}

/** A panel with its side bar, and a chevron that points the way it moves: in to fold, out to open. */
export function PanelIcon({ open }: { open: boolean }) {
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
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5v11" />
      <path d={open ? 'M10.5 6 8.5 8l2 2' : 'M8.5 6l2 2-2 2'} />
    </svg>
  );
}
