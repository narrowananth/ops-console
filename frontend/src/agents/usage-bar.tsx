const HOUR_MS = 3_600_000;

export function resetsIn(iso: string | null): string {
  if (iso === null) return '';
  const left = Date.parse(iso) - Date.now();
  if (left <= 0) return 'reset';
  if (left >= 24 * HOUR_MS) return `resets in ${Math.round(left / (24 * HOUR_MS))}d`;
  const hours = Math.floor(left / HOUR_MS);
  const minutes = Math.floor((left % HOUR_MS) / 60_000);
  return `resets in ${hours ? `${hours}h ` : ''}${minutes}m`;
}

export function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function UsageBar({
  label,
  tip,
  pct,
  resetsAt,
  accentAt,
}: {
  label: string;
  tip: string;
  pct: number | null;
  resetsAt: string | null;
  accentAt: number;
}) {
  const hot = pct !== null && pct >= accentAt;
  return (
    <div className="grid grid-cols-[48px_minmax(0,1fr)_160px] items-center gap-2.5">
      <span title={tip} className="text-xs text-neutral-700">
        {label}
      </span>
      <span className="block h-1.5 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
        <span
          className={`block h-1.5 rounded-full ${hot ? 'bg-accent' : 'bg-text'}`}
          style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
        />
      </span>
      <span className={`font-mono text-xs ${hot ? 'text-accent-700' : 'text-neutral-800'}`}>
        {pct === null ? 'no usage yet' : `${Math.round(pct)}% · ${resetsIn(resetsAt)}`}
      </span>
    </div>
  );
}
