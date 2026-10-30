import type { ReactNode } from 'react';

/** Pane-level empty, loading or error message. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-6 py-5 text-[13px] text-neutral-700">{children}</div>;
}
