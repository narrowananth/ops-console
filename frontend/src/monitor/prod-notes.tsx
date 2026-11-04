import type { Alert, ReportStep } from '@ops-console/shared';
import { ago } from './scan-scope';

const WARNING = 'rounded-full bg-accent-100 px-2 py-px text-accent-700';

/** How long since a Scan read the Alert's Service, as a warning once a Scan was missed. */
export function FreshnessNote({ alert }: { alert: Alert }) {
  if (alert.last_scanned_at === null) {
    return (
      <span className={WARNING} title="No Scan has read this Service since the console began recording Scans.">
        never scanned
      </span>
    );
  }
  const text = `last scanned ${ago(alert.last_scanned_at)}`;
  if (!alert.scan_overdue) {
    return (
      <span className="text-neutral-700" title="When the newest finished Scan read this Service.">
        {text}
      </span>
    );
  }
  return (
    <span className={WARNING} title="No Scan has read this Service for 2 Check intervals. The failure may be gone.">
      {text} · a Scan was missed
    </span>
  );
}

/** A merged Fix that no Scan has yet seen healthy. */
export function MergeNote({ alert }: { alert: Alert }) {
  if (!alert.awaiting_prod_check) return null;
  return (
    <span
      className="text-neutral-700"
      title="The next Scan that reads this Service and does not see the failure clears this."
    >
      Merged, not yet seen healthy in prod
    </span>
  );
}

/** The Recheck and deployed-version steps of a Report: results the operator reads before the Report text. */
export function ReportNotes({ steps }: { steps: ReportStep[] }) {
  const notes = steps.filter((step) => step.kind === 'result' || step.kind === 'warning');
  if (notes.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
      {notes.map((note, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the notes are an ordered, append-only slice of the steps
        <li key={index} className={note.kind === 'warning' ? WARNING : 'text-neutral-700'}>
          {note.text}
        </li>
      ))}
    </ul>
  );
}
