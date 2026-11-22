import {
  type AlertListItem,
  CONNECTOR_NAMES,
  LOG_SOURCES,
  type LogSource,
  type ScanWindow,
  SEVERITIES,
  type Severity,
} from '@ops-console/shared';
import { Fragment, useEffect, useState } from 'react';
import { z } from 'zod';
import { BrandIcon, CONNECTOR_BRAND } from '../components/ui/brand-icon';
import { item, menu } from '../components/ui/item';
import { useStored } from '../lib/remember';
import { SOURCE_LABEL } from './log-source';
import type { MonitorData } from './monitor-data';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

const TIER_DOT: Record<Severity, string> = { high: 'bg-accent', medium: 'bg-warn', low: 'bg-neutral-400' };

const LINK = 'cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-accent-700 hover:text-accent-600';

/** Open Alerts of one Service, by tier, as coloured counts. */
function Tiers({ alerts }: { alerts: AlertListItem[] }) {
  if (alerts.length === 0) return null;
  return (
    <span className="flex items-center gap-1.5">
      {SEVERITIES.map((severity) => {
        const count = alerts.filter((alert) => alert.severity === severity).length;
        if (count === 0) return null;
        return (
          <span
            key={severity}
            title={`${count} open ${severity} ${count === 1 ? 'Alert' : 'Alerts'}`}
            className="flex items-center gap-1 font-mono text-xs text-neutral-700"
          >
            <span aria-hidden className={`size-1.5 rounded-full ${TIER_DOT[severity]}`} />
            {count}
            <span className="sr-only">{severity}</span>
          </span>
        );
      })}
    </span>
  );
}

/** The Services ticked to Scan; kept across reloads. A ticked one missing from this range stays ticked. */
export function useTicked() {
  return useStored('monitor.ticked', z.array(z.string()), []);
}

/**
 * The toolbar's Services button and the menu it opens: the Services with failing requests in the range, across every
 * env. Clicking a name shows only its logs; the tick box adds it to the next Scan.
 */
export function ServicesMenu({
  data,
  range,
  selected,
  onSelect,
  ticked,
  onTick,
}: {
  data: MonitorData;
  range: ScanWindow;
  selected: string | null;
  onSelect: (name: string | null) => void;
  ticked: string[];
  onTick: (names: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // Sources whose Services are folded away.
  const [folded, setFolded] = useState<LogSource[]>([]);
  const [filter, setFilter] = useStored('monitor.services-filter', z.string(), '');
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const { rows, byService } = data;
  const top = Math.max(1, ...rows.map((row) => row.errors ?? 0));
  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows;
  const toScan = ticked.filter((name) => rows.some((row) => row.name === name));
  const allTicked = shown.length > 0 && shown.every((row) => toScan.includes(row.name));
  const tick = (name: string) =>
    onTick(ticked.includes(name) ? ticked.filter((other) => other !== name) : [...ticked, name]);
  const tickAll = () => {
    const names = shown.map((row) => row.name);
    onTick(allTicked ? ticked.filter((name) => !names.includes(name)) : [...new Set([...ticked, ...names])]);
  };
  // The boxes show on hover, and on every row once one is ticked.
  const box = `absolute top-2.5 left-2.5 z-1 size-3.5 cursor-pointer accent-accent focus-visible:opacity-100 ${toScan.length > 0 ? '' : 'opacity-0 group-hover:opacity-100'}`;

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
        title={`The Services in ${data.names} with failing requests in the range, across every env. Pick one to see its logs; tick it to Scan it.`}
        onClick={() => setOpen(!open)}
        className={`flex max-w-60 cursor-pointer items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-left text-xs whitespace-nowrap transition-colors hover:border-neutral-400 ${open ? 'border-accent-400 shadow-[0_0_0_3px_var(--color-accent-100)]' : 'border-line'}`}
      >
        <svg
          aria-hidden
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          className="flex-none text-neutral-600"
        >
          <path d="M8 2 14 5 8 8 2 5ZM2 8l6 3 6-3M2 11l6 3 6-3" />
        </svg>
        <span className="min-w-0 truncate font-semibold">{selected ?? `${rows.length} Services`}</span>
        {toScan.length > 0 && (
          <span className="flex-none rounded-full bg-accent-100 px-1.5 font-mono text-[11px] text-accent-700">
            {toScan.length} ticked
          </span>
        )}
        <span aria-hidden className="flex-none text-neutral-600">
          ▾
        </span>
      </button>
      {open && (
        <div
          className={`absolute top-full right-0 z-51 mt-1 flex max-h-110 w-88 max-w-[calc(100vw-96px)] flex-col ${menu}`}
        >
          {rows.length > 8 && (
            <input
              type="search"
              aria-label="Filter Services"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={`Filter ${rows.length}`}
              className="m-1 mb-1.5 rounded-lg border border-line bg-bg px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent-400"
            />
          )}
          <button
            type="button"
            aria-current={selected === null}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 px-2.5 py-2 ${item(selected === null)}`}
          >
            <strong className="text-[13px]">All Services</strong>
            <span className="ml-auto font-mono text-xs text-neutral-700">{rows.length}</span>
          </button>
          {shown.length > 0 && (
            <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1 text-xs text-neutral-700">
              {toScan.length > 0 ? (
                <strong className="font-semibold text-text">{toScan.length} ticked</strong>
              ) : (
                <span>Tick Services to Scan</span>
              )}
              <span className="flex gap-2.5">
                {!allTicked && (
                  <button type="button" onClick={tickAll} className={LINK} title="Tick every Service shown">
                    Tick all
                  </button>
                )}
                {toScan.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onTick([])}
                    className={LINK}
                    title="Clear the ticks. The Scan then reads the picked Service, or every listed one."
                  >
                    Clear
                  </button>
                )}
              </span>
            </div>
          )}
          <ul aria-label="Services" className="m-0 flex min-h-0 list-none flex-col gap-px overflow-y-auto p-0">
            {LOG_SOURCES.map((source) => {
              const group = shown.filter((row) => row.source === source);
              if (group.length === 0) return null;
              const isFolded = folded.includes(source) && needle === '';
              const names = group.map((row) => row.name);
              const ticks = names.filter((name) => toScan.includes(name)).length;
              return (
                <Fragment key={source}>
                  <li role="presentation" className="flex items-center gap-1.5 px-1.5 pt-2 pb-1">
                    <input
                      type="checkbox"
                      aria-label={`Scan every ${SOURCE_LABEL[source]} Service`}
                      title={`Tick every ${SOURCE_LABEL[source]} Service shown`}
                      checked={ticks === group.length}
                      ref={(node) => {
                        if (node) node.indeterminate = ticks > 0 && ticks < group.length;
                      }}
                      onChange={() =>
                        onTick(
                          ticks === group.length
                            ? ticked.filter((name) => !names.includes(name))
                            : [...new Set([...ticked, ...names])],
                        )
                      }
                      className="size-3.5 flex-none cursor-pointer accent-accent"
                    />
                    <button
                      type="button"
                      aria-expanded={!isFolded}
                      aria-label={`${SOURCE_LABEL[source]}, ${group.length} ${group.length === 1 ? 'Service' : 'Services'}`}
                      title={`${isFolded ? 'Show' : 'Hide'} the ${CONNECTOR_NAMES[source]} Services`}
                      onClick={() =>
                        setFolded(
                          folded.includes(source) ? folded.filter((one) => one !== source) : [...folded, source],
                        )
                      }
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-xs font-semibold tracking-[0.04em] text-neutral-700 uppercase hover:bg-neutral-200"
                    >
                      <span
                        aria-hidden
                        className={`flex-none text-neutral-600 transition-transform ${isFolded ? '-rotate-90' : ''}`}
                      >
                        ▾
                      </span>
                      <BrandIcon brand={CONNECTOR_BRAND[source]} size="xs" />
                      <span className="min-w-0 truncate">{SOURCE_LABEL[source]}</span>
                      <span className="ml-auto flex-none font-mono tracking-normal normal-case">{group.length}</span>
                    </button>
                  </li>
                  {!isFolded &&
                    group.map((row) => {
                      const mine = byService.get(`${row.source}:${row.name}`) ?? [];
                      const picked = selected === row.name;
                      return (
                        <li key={`${row.source}:${row.name}`} className="group relative">
                          <input
                            type="checkbox"
                            aria-label={`Scan ${row.name}`}
                            title={`Tick to add ${row.name} to the next Scan. Clicking the name only shows its logs.`}
                            checked={toScan.includes(row.name)}
                            onChange={() => tick(row.name)}
                            className={box}
                          />
                          <button
                            type="button"
                            aria-current={picked}
                            onClick={() => {
                              onSelect(row.name);
                              setOpen(false);
                            }}
                            className={`flex w-full flex-col gap-1.5 py-2 pr-2.5 pl-8 ${item(picked)}`}
                          >
                            <span className="flex w-full items-baseline gap-2">
                              <span className="min-w-0 truncate text-[13px] font-semibold">{row.name}</span>
                              <span
                                className="ml-auto flex-none font-mono text-xs text-neutral-700"
                                title={
                                  row.errors === null
                                    ? 'No failing requests in this range. It is listed for its open Alerts from earlier Scans.'
                                    : `${row.errors} failing requests in the last ${range}`
                                }
                              >
                                {row.errors === null ? '0' : compact.format(row.errors)}
                              </span>
                            </span>
                            <span className="flex h-3 w-full items-center gap-2.5">
                              <span aria-hidden className="h-1 flex-1 overflow-hidden rounded-full bg-neutral-300/70">
                                <span
                                  className="block h-full rounded-full bg-accent/65"
                                  style={{ width: `${Math.max(2, ((row.errors ?? 0) / top) * 100)}%` }}
                                />
                              </span>
                              <Tiers alerts={mine} />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                </Fragment>
              );
            })}
          </ul>
          {data.reading && (
            <p className="m-0 px-2.5 py-2 text-xs text-neutral-700">Reading Services from {data.names}…</p>
          )}
          {data.listError && (
            <p role="alert" className="m-0 px-2.5 py-2 text-xs text-accent-700">
              Could not read Services: {data.listError.message}
            </p>
          )}
          {data.allRead && rows.length === 0 && (
            <p className="m-0 px-2.5 py-2 text-xs text-neutral-700">
              No failing requests in {range} for these status codes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
