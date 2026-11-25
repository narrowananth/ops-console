import { useMemo, useState } from 'react';
import { parseDelimited, type SortDirection, sortRows } from './csv';

/** Rows past this many are left out of the table; Download has them all. */
export const ROWS_SHOWN = 1000;

const NEXT: Record<string, SortDirection | null> = { none: 'asc', asc: 'desc', desc: null };

/** CSV or TSV as a table: a header that stays in view, a click on it to sort, and the first 1000 rows. */
export function TableView({ text, delimiter }: { text: string; delimiter: ',' | '\t' }) {
  const parsed = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  const [head, ...rows] = parsed;
  const [sort, setSort] = useState<{ column: number; direction: SortDirection } | null>(null);
  const sorted = useMemo(
    () => (sort ? sortRows(parsed.slice(1), sort.column, sort.direction) : parsed.slice(1)),
    [parsed, sort],
  );
  if (!head) return <p className="m-0 p-6 text-sm text-neutral-700">The file has no rows.</p>;
  return (
    <div className="flex h-full min-h-0 w-full flex-col self-start">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse font-mono text-xs">
          <thead>
            <tr>
              {head.map((name, column) => {
                const direction = sort?.column === column ? sort.direction : null;
                return (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: two columns may share a name
                    key={column}
                    scope="col"
                    aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
                    className="sticky top-0 border-b border-line bg-surface p-0 text-left"
                  >
                    <button
                      type="button"
                      title="Sort by this column"
                      onClick={() => {
                        const next = NEXT[direction ?? 'none'] ?? null;
                        setSort(next ? { column, direction: next } : null);
                      }}
                      className="flex w-full cursor-pointer items-center gap-1 border-0 bg-transparent px-2.5 py-1.5 text-left font-mono text-xs font-semibold whitespace-nowrap text-text hover:bg-neutral-200"
                    >
                      {name}
                      <span aria-hidden className="text-neutral-600">
                        {direction === 'asc' ? '▲' : direction === 'desc' ? '▼' : ''}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, ROWS_SHOWN).map((row, at) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id of their own
              <tr key={at} className="border-b border-line hover:bg-neutral-200/60">
                {row.map((cell, column) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells sit by position
                  <td key={column} className="max-w-[60ch] px-2.5 py-1 align-top break-words whitespace-pre-wrap">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 border-t border-line px-4 py-1.5 text-xs text-neutral-700">
        {rows.length === 1 ? '1 row' : `${rows.length} rows`}
        {rows.length > ROWS_SHOWN && ` · showing the first ${ROWS_SHOWN}. Download has all of them.`}
      </p>
    </div>
  );
}
