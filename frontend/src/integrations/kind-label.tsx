import type { ReactNode } from 'react';

/** Whether an Integrations row is a Connector or an MCP Server. */
export function KindLabel({ children }: { children: ReactNode }) {
  return (
    <span className="border border-divider px-1.5 py-px font-mono text-[10px] tracking-[0.04em] text-neutral-700 uppercase">
      {children}
    </span>
  );
}
