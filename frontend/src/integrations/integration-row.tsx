import type { ReactNode } from 'react';
import { KindLabel } from './kind-label';

/** The row action: plain text, the same for Connectors and MCP Servers. */
export const rowAction =
  'cursor-pointer border-0 bg-transparent p-0 text-right text-xs text-neutral-700 hover:text-text hover:underline disabled:cursor-default disabled:opacity-50';

/** One row of Settings › Integrations: name and kind, a line under it, the status, and one action. */
export function IntegrationRow(props: {
  label: string;
  name: ReactNode;
  kind: 'Connector' | 'MCP';
  line: string;
  alert?: boolean;
  status: { glyph: string; className: string };
  onOpen: () => void;
  action: ReactNode;
}) {
  return (
    <li
      aria-label={props.label}
      className="grid grid-cols-[minmax(0,1fr)_128px_88px] items-center gap-3 border-b border-neutral-300 pr-5 hover:bg-neutral-200"
    >
      <button
        type="button"
        onClick={props.onOpen}
        className="col-span-2 grid cursor-pointer grid-cols-subgrid items-center border-0 bg-transparent py-3 pl-5 text-left text-text"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-extrabold">{props.name}</span>
            <KindLabel>{props.kind}</KindLabel>
          </span>
          <span
            className={`block truncate font-mono text-[11px] ${props.alert ? 'text-accent-700' : 'text-neutral-700'}`}
          >
            {props.line}
          </span>
        </span>
        <span className={`font-mono text-xs whitespace-nowrap ${props.status.className}`}>{props.status.glyph}</span>
      </button>
      <span className="justify-self-end">{props.action}</span>
    </li>
  );
}
