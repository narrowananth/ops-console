import { useAlertsToggle } from './alerts';

/** The pill that turns desktop alerts on or off for runs that need the operator and runs that end. */
export function AlertsPill() {
  const { on, refused, toggle } = useAlertsToggle();
  return (
    <button
      type="button"
      aria-pressed={on}
      title={
        refused
          ? 'The browser did not allow alerts. Allow notifications for this site, then try again.'
          : 'A desktop alert when a run needs you or ends, while this console is open in a tab you are not looking at'
      }
      onClick={() => void toggle()}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs shadow-sm ${
        on ? 'border-divider bg-card text-text' : 'border-divider bg-transparent text-neutral-700'
      }`}
    >
      <span aria-hidden className={`size-1.75 rounded-full ${on ? 'bg-ok' : 'bg-neutral-400'}`} />
      Alerts {on ? 'on' : 'off'}
    </button>
  );
}
