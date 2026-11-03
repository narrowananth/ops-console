import type { ReactNode } from 'react';
import { BrandIcon } from '../components/ui/brand-icon';
import type { BrandSlug } from '../components/ui/brands';
import type { StatusLook } from '../mcp/status';
import { KindLabel } from './kind-label';

const action =
  'min-w-21 cursor-pointer border px-3 py-1.25 text-center text-xs font-semibold shadow-sm transition-colors disabled:cursor-default disabled:opacity-50';

/** The row action: a small button, the same for Connectors and MCP Servers. */
export const rowAction = `${action} border-line bg-card text-text hover:bg-neutral-200`;

/** The row action when the row needs the operator: Sign in or Reconnect. */
export const rowActionAttention = `${action} border-accent/45 bg-accent-100 text-accent-700 hover:bg-accent-200`;

/** The status pill's fill follows its text colour. */
function pill(className: string): string {
  if (className.includes('accent')) return 'bg-accent-100';
  if (className.includes('text-ok')) return 'bg-ok/12';
  return 'bg-neutral-200';
}

/** One row of Integrations: name and kind, a line under it, the status, and one action. */
export function IntegrationRow(props: {
  label: string;
  brand: BrandSlug;
  name: ReactNode;
  kind: 'Connector' | 'MCP';
  line: string;
  alert?: boolean;
  selected?: boolean;
  status: StatusLook;
  onOpen: () => void;
  action: ReactNode;
}) {
  return (
    <li
      aria-label={props.label}
      className={`grid grid-cols-[minmax(0,1fr)_auto_96px] items-center gap-4 rounded-lg pr-3.5 transition-colors ${
        props.selected ? 'bg-accent-100 shadow-[inset_0_0_0_1px_var(--color-accent-200)]' : 'hover:bg-neutral-200/70'
      }`}
    >
      <button
        type="button"
        onClick={props.onOpen}
        className="col-span-2 grid cursor-pointer grid-cols-subgrid items-center rounded-lg border-0 bg-transparent py-2.5 pl-3 text-left text-text"
      >
        <span className="flex min-w-0 items-center gap-3.5">
          <BrandIcon brand={props.brand} size="lg" />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{props.name}</span>
              <KindLabel>{props.kind}</KindLabel>
            </span>
            <span className={`block truncate text-xs ${props.alert ? 'text-accent-700' : 'text-neutral-700'}`}>
              {props.line}
            </span>
          </span>
        </span>
        <span
          title={props.status.tip}
          className={`justify-self-end rounded-full px-2.5 py-0.75 font-mono text-xs whitespace-nowrap ${pill(props.status.className)} ${props.status.className}`}
        >
          {props.status.glyph}
        </span>
      </button>
      <span className="justify-self-end">{props.action}</span>
    </li>
  );
}
