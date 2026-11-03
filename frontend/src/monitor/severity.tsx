import { Severity } from '@ops-console/shared';

export const SEVERITY_LABEL: Record<Severity, string> = {
  [Severity.High]: 'High',
  [Severity.Medium]: 'Medium',
  [Severity.Low]: 'Low',
};

/** What each tier means, shown on hover. The thresholds are the Datadog Connector's settings. */
export const SEVERITY_TIP: Record<Severity, string> = {
  [Severity.High]: 'High: in one 10-minute stretch the errors reached the rapid threshold. Look at these first.',
  [Severity.Medium]:
    'Medium: errors per hour reached the failing threshold, and the logs are errors or the code is 500 or more.',
  [Severity.Low]: 'Low: failing, but below the Medium and High thresholds.',
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
      title={SEVERITY_TIP[severity]}
      className={`inline-flex flex-none items-center rounded-full px-2 py-px text-xs font-semibold tracking-[0.06em] uppercase ${TONE[severity]}`}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  );
}
