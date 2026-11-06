import { Link } from 'react-router-dom';
import { useAlertsStatus } from './alerts';

const TEXT = { on: 'Alerts on', off: 'Alerts off', blocked: 'Alerts blocked' } as const;

/** Whether desktop alerts are on, read only: a link to where they are set, Accounts & Usage › Notifications. */
export function AlertsPill() {
  const status = useAlertsStatus();
  return (
    <Link
      to="/agents#notifications"
      title={
        status === 'blocked'
          ? 'The browser blocks alerts for this site. Allow notifications in the browser, then set them in Accounts & Usage › Notifications.'
          : 'Set in Accounts & Usage › Notifications'
      }
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs no-underline shadow-sm ${
        status === 'on' ? 'border-divider bg-card text-text' : 'border-divider bg-transparent text-neutral-700'
      }`}
    >
      <span
        aria-hidden
        className={`size-1.75 rounded-full ${status === 'on' ? 'bg-ok' : status === 'blocked' ? 'bg-accent' : 'bg-neutral-400'}`}
      />
      {TEXT[status]}
    </Link>
  );
}
