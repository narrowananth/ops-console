import type { ReactNode } from 'react';
import { z } from 'zod';
import { useStored } from '../../lib/remember';

/**
 * Whether the operator folded a card down to its header. Kept per kind of card (`agent-review`, `report`), so a card
 * they folded stays folded on every pull request or Alert, through reloads, until they open it again.
 */
export function useFold(kind: string): [boolean, () => void] {
  const [folded, setFolded] = useStored(`fold.${kind}`, z.boolean(), false);
  return [folded, () => setFolded((now) => !now)];
}

/** A card's title with the chevron that folds the card; the whole title is the button, named `Fold <label>`. */
export function FoldTitle({
  label,
  folded,
  onToggle,
  children,
}: {
  label: string;
  folded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={`Fold ${label}`}
      aria-expanded={!folded}
      title={folded ? 'Open' : 'Fold'}
      onClick={onToggle}
      className="-ml-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-left font-[inherit] text-[inherit] text-text hover:bg-neutral-200"
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
      {children}
    </button>
  );
}
