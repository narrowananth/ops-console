import type { Cell, Connection, Part } from '@ops-console/shared';
import { COPY_FAILED, copyLabel, useCopy } from '../lib/clipboard';
import { PROD_TIP, TYPE_LABELS } from './fields';

type ResultPart = Extract<Part, { kind: 'result' }>;
type ComparisonPart = Extract<Part, { kind: 'comparison' }>;

/** A cell that holds an object or a list, as the agent's JSON text; null when it is not whole JSON (cut at 200). */
function json(value: Cell): unknown {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** A cell as text: JSON indented, so a nested object reads one key per line; an empty cell as a dash. */
const shown = (value: Cell) => {
  if (value === null) return '—';
  const parsed = json(value);
  return parsed === null ? String(value) : JSON.stringify(parsed, null, 2);
};

function CopyJson({ value }: { value: unknown }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      title={copied === 'failed' ? COPY_FAILED : 'Copy these rows as JSON to the clipboard'}
      onClick={() => copy(JSON.stringify(value, null, 2))}
      className="ml-auto cursor-pointer border border-neutral-700 bg-transparent px-1.5 font-mono text-[10px] text-neutral-400 hover:text-neutral-100"
    >
      {copyLabel(copied, 'Copy JSON')}
    </button>
  );
}

/**
 * Rows under their columns. A long cell wraps inside its column rather than running off the right edge, and rows are
 * ruled so a wrapped cell still reads as one row.
 */
function Table({ head, rows, marked }: { head: string[]; rows: Cell[][]; marked?: boolean[] }) {
  return (
    <div className="overflow-x-auto pl-4">
      <table className="border-collapse font-mono text-xs">
        <thead>
          <tr>
            {head.map((column, index) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: two columns may share a name
                key={index}
                className="border-b border-neutral-600 py-0.5 pr-4 text-left align-bottom font-semibold whitespace-nowrap text-neutral-300"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id of their own
              key={rowIndex}
              className={`border-b border-neutral-800 hover:bg-neutral-800/60 ${marked?.[rowIndex] ? 'text-accent-400' : ''}`}
            >
              {row.map((value, index) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells sit by position
                  key={index}
                  className={`py-1 pr-4 align-top ${value === null ? 'text-neutral-600' : ''}`}
                >
                  <div className={index === 0 ? 'whitespace-nowrap' : 'max-w-[60ch] break-words whitespace-pre-wrap'}>
                    {shown(value)}
                  </div>
                </td>
              ))}
              {marked?.[rowIndex] && <td className="py-1 align-top whitespace-nowrap">◀ differs</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A single row of more than this many columns shows as one line per column: a wide row would run off the right. */
const WIDE = 3;

/** One Connection's rows for one question, under its name, type and PROD tag. */
export function ResultView({ part, connections }: { part: ResultPart; connections: Connection[] }) {
  const connection = connections.find((candidate) => candidate.name === part.connection);
  const { kind: _kind, ...json } = part;
  const total = part.total ?? part.rows.length;
  return (
    <section aria-label={`Result from ${part.connection}`} className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-2 font-semibold">
        <span>
          ── {part.connection}
          {connection && ` · ${TYPE_LABELS[connection.type]}`}
        </span>
        {connection?.is_prod && (
          <span title={PROD_TIP} className="bg-accent px-1 text-[9px] font-extrabold text-neutral-900">
            PROD
          </span>
        )}
        <CopyJson value={json} />
      </div>
      {part.query && <div className="pl-4 whitespace-pre-wrap text-neutral-500">{part.query}</div>}
      {part.rows.length === 0 ? (
        <div className="pl-4 text-neutral-500">· no matches</div>
      ) : (
        <>
          {part.rows.length === 1 && part.columns.length > WIDE ? (
            <Table
              head={['field', 'value']}
              rows={part.columns.map((column, index) => [column, part.rows[0]?.[index] ?? null])}
            />
          ) : (
            <Table head={part.columns} rows={part.rows} />
          )}
          <div className="pl-4 text-neutral-500">
            ✓ {total} {total === 1 ? 'row' : 'rows'}
            {total > part.rows.length && ` · showing ${part.rows.length}`}
            {part.ms !== null && ` · ${part.ms}ms`}
          </div>
        </>
      )}
    </section>
  );
}

/** The agent's match across Connections: one row per field, the rows that differ marked. */
export function ComparisonView({ part }: { part: ComparisonPart }) {
  const { kind: _kind, ...json } = part;
  const differing = part.rows.filter((row) => row.differs).length;
  return (
    <section
      aria-label={`Compared on ${part.key}`}
      className="my-1 flex flex-col gap-1 border-l-3 border-accent py-1 pl-2"
    >
      <div className="flex items-center gap-2 font-semibold">
        <span title="The agent matched the rows each Connection gave on this key: one row per field, the ones whose values differ marked.">
          ■ Compared on {part.key} = {part.value}
        </span>
        <CopyJson value={json} />
      </div>
      <Table
        head={['field', ...part.connections]}
        rows={part.rows.map((row) => [row.field, ...row.values])}
        marked={part.rows.map((row) => row.differs)}
      />
      <div className="pl-4 text-neutral-500">
        {differing === 0 ? 'Every shared field agrees.' : `${differing} of ${part.rows.length} fields differ.`}
      </div>
    </section>
  );
}
