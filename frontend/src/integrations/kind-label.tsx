import type { ReactNode } from 'react';

/** Whether an Integrations row is a Connector or an MCP Server. */
export function KindLabel({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-neutral-200 px-1.75 py-0.5 text-[9.5px] font-bold tracking-[0.06em] text-neutral-700 uppercase">
      {children}
    </span>
  );
}
