import { Severity } from '@ops-console/shared';

export const SEVERITY_LABEL: Record<Severity, string> = {
  [Severity.High]: 'High',
  [Severity.Medium]: 'Medium',
  [Severity.Low]: 'Low',
};

const TONE: Record<Severity, string> = {
  [Severity.High]: 'bg-accent text-white',
  [Severity.Medium]: 'bg-warn/15 text-warn',
  [Severity.Low]: 'bg-neutral-200 text-neutral-700',
};

/** An Alert's tier as a small pill: red for High, amber for Medium, grey for Low. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-flex flex-none items-center rounded-full px-2 py-px text-[10px] font-extrabold tracking-[0.06em] uppercase ${TONE[severity]}`}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  );
}
