import type { StatusCodeCount } from '@ops-console/shared';
import { useEffect, useState } from 'react';
import { item, menu } from '../components/ui/item';
import type { ScanScope } from './scan-scope';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

const REASON: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  499: 'Client Closed Request',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

type Kind = '4xx' | '5xx' | 'other';

const KINDS: { kind: Kind; label: string }[] = [
  { kind: '4xx', label: '4xx · client errors' },
  { kind: '5xx', label: '5xx · server errors' },
  { kind: 'other', label: 'Other codes' },
];

const KIND_TIP: Record<Kind, string> = {
  '4xx': 'A client error: the Service refused the request.',
  '5xx': 'A server error: the Service failed while answering.',
  other: 'A code past the 5xx range.',
};

const kindOf = (code: number): Kind => (code < 500 ? '4xx' : code < 600 ? '5xx' : 'other');

/** An HTTP status code as a small pill: amber for a client error, red for a server error or anything past 5xx. */
export function StatusBadge({ code }: { code: number }) {
  const tone = kindOf(code) === '4xx' ? 'bg-warn/15 text-warn' : 'bg-accent-100 text-accent-700';
  return (
    <span
      title={`HTTP ${code}${REASON[code] ? ` ${REASON[code]}` : ''}. ${KIND_TIP[kindOf(code)]}`}
      className={`inline-flex flex-none items-center rounded px-1.5 font-mono text-xs font-semibold ${tone}`}
    >
      {code}
    </span>
  );
}

/** The HTTP status codes to read, as one field that opens the codes Datadog has, by class, with counts. */
export function StatusPicker({ known, scope }: { known: StatusCodeCount[]; scope: ScanScope }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const all = known.map((entry) => entry.code);
  const every = scope.codes.length === 0;
  const isOn = (code: number) => every || scope.codes.includes(code);
  /** Ticking every known code is the same as every code, which also takes in codes that show up later. */
  const pick = (next: number[]) => scope.pickCodes(all.every((code) => next.includes(code)) ? [] : next);
  const effective = every ? all : scope.codes;
  const toggle = (codes: number[], on: boolean) => {
    const next = on ? [...effective, ...codes] : effective.filter((code) => !codes.includes(code));
    // Nothing ticked reads nothing; keep at least one code.
    if (next.length > 0) pick(next);
  };
  const summary = every ? 'all from 400 up' : scope.codes.join(', ');

  return (
    <div className="relative">
      {open && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-50 cursor-default"
          onClick={() => setOpen(false)}
        />
      )}
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Status"
        title="The HTTP status codes a Scan reads and the lists show. Every code from 400 up by default."
        onClick={() => setOpen(!open)}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left text-xs shadow-sm transition-colors hover:border-neutral-400 ${open ? 'border-accent-400 shadow-[0_0_0_3px_var(--color-accent-100)]' : 'border-divider'}`}
      >
        <span className="flex-none text-neutral-700">Status</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{summary}</span>
        <span
          title={
            every
              ? undefined
              : `${scope.codes.length} of the ${known.length} codes Datadog has in this range are picked`
          }
          className="flex-none rounded-full bg-neutral-200 px-1.5 font-mono text-xs text-neutral-700"
        >
          {every ? 'all' : `${scope.codes.length}/${known.length}`}
        </span>
      </button>
      {open && (
        <fieldset className={`absolute top-full right-0 left-0 z-51 m-0 mt-1 max-h-96 overflow-auto ${menu}`}>
          <legend className="sr-only">HTTP status codes to read</legend>
          <label className={`flex items-center gap-2.5 px-2.5 py-1.5 ${item(every)}`}>
            <input
              type="checkbox"
              checked={every}
              onChange={() => scope.pickCodes([])}
              className="size-3.5 flex-none cursor-pointer accent-accent"
            />
            <span className="flex-1 text-xs font-semibold">Every code from 400 up</span>
          </label>
          {known.length === 0 && (
            <p className="m-0 px-2.5 py-1.5 text-xs text-neutral-700">No failing requests in this range.</p>
          )}
          {KINDS.map(({ kind, label }) => {
            const codes = known.filter((entry) => kindOf(entry.code) === kind);
            if (codes.length === 0) return null;
            const ticked = codes.every((entry) => isOn(entry.code));
            return (
              <div key={kind} className="border-t border-line pt-1">
                <label className="flex cursor-pointer items-center gap-2.5 px-2.5 py-1 text-xs font-semibold tracking-[0.04em] text-neutral-700 uppercase">
                  <input
                    type="checkbox"
                    checked={ticked}
                    onChange={() =>
                      toggle(
                        codes.map((entry) => entry.code),
                        !ticked,
                      )
                    }
                    className="size-3.5 flex-none cursor-pointer accent-accent"
                  />
                  {label}
                </label>
                {codes.map((entry) => (
                  <label
                    key={entry.code}
                    className={`flex items-center gap-2.5 py-1.5 pr-2.5 pl-6 ${item(!every && isOn(entry.code))}`}
                  >
                    <input
                      type="checkbox"
                      checked={isOn(entry.code)}
                      onChange={() => toggle([entry.code], !isOn(entry.code))}
                      className="size-3.5 flex-none cursor-pointer accent-accent"
                    />
                    <StatusBadge code={entry.code} />
                    <span className="min-w-0 flex-1 truncate text-xs">{REASON[entry.code] ?? 'Other'}</span>
                    <span className="flex-none font-mono text-xs text-neutral-700">{compact.format(entry.count)}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}
