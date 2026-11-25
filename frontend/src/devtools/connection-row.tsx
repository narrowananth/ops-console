import type { Connection } from '@ops-console/shared';
import { BrandIcon, CONNECTION_BRAND } from '../components/ui/brand-icon';
import { item } from '../components/ui/item';
import { PROD_TIP } from './fields';

/** The PROD tag of a Connection, wherever its name shows. */
export const ProdTag = () => (
  <span title={PROD_TIP} className="rounded-full bg-accent-100 px-1.75 py-px text-xs font-semibold text-accent-700">
    PROD
  </span>
);

/** A Connection to tick in a scope: check box, brand icon, name and PROD tag. The Dev tools list and the composer menu share it. */
export function ConnectionRow({
  connection,
  on,
  disabled = false,
  title,
  onToggle,
}: {
  connection: Connection;
  on: boolean;
  disabled?: boolean;
  title: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onToggle}
      className={`flex w-full items-center gap-2.5 px-2.5 py-2 ${item(on)}`}
    >
      <span
        aria-hidden
        className={`flex size-4 flex-none items-center justify-center rounded-[5px] border transition-colors ${
          on ? 'border-accent bg-accent text-white' : 'border-neutral-400 bg-card'
        }`}
      >
        {on && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="m2.5 6 2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <BrandIcon brand={CONNECTION_BRAND[connection.type]} size="sm" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{connection.name}</span>
      {connection.is_prod && <ProdTag />}
    </button>
  );
}
