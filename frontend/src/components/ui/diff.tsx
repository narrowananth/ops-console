import { Fragment, type ReactNode } from 'react';

type DiffLine = { sign: '+' | '-' | ' '; text: string };

/** Comments on the new side of a diff: what shows under a line, and the `+` that opens a comment on it. */
export type LineComments = {
  /** What sits under the new-side line `line`: its threads and an open comment box; null for nothing. */
  below: (line: number) => ReactNode;
  onAdd: (line: number) => void;
};

/** `at`: the new-side line a removed line sits before. */
type Row = DiffLine & { hunk: boolean; old: number | null; new: number | null; at: number };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Numbers each line from the hunk header above it: old side for removed lines, new side for added ones. */
function numbered(lines: DiffLine[]): Row[] {
  let old = 0;
  let next = 0;
  return lines.map((line) => {
    const hunk = line.sign === ' ' ? HUNK.exec(line.text) : null;
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      return { ...line, hunk: true, old: null, new: null, at: next };
    }
    if (line.sign === '+') return { ...line, hunk: false, old: null, new: next++, at: next };
    if (line.sign === '-') return { ...line, hunk: false, old: old++, new: null, at: next };
    return { ...line, hunk: false, old: old++, new: next++, at: next };
  });
}

const LOOK = {
  '+': { row: 'bg-diff-add', gutter: 'bg-diff-add-strong text-diff-add-text', sign: 'text-diff-add-text' },
  '-': { row: 'bg-diff-del', gutter: 'bg-diff-del-strong text-diff-del-text', sign: 'text-diff-del-text' },
  ' ': { row: '', gutter: 'text-neutral-500', sign: '' },
};

const GUTTER = 'w-px select-none px-2 text-right align-top whitespace-nowrap';
const SIGN = { '+': '+', '-': '−', ' ': '' };
const TABLE = 'min-w-full border-collapse font-mono text-xs leading-5';

/** Threads and a comment box under a line, as wide as the diff's visible width. */
function Below({ span, node }: { span: number; node: ReactNode }) {
  if (node === null || node === undefined || node === false) return null;
  return (
    <tr>
      <td colSpan={span} className="border-y border-line bg-surface p-0">
        <div className="sticky left-0 flex max-w-[min(100%,56rem)] flex-col gap-2 px-3 py-2.5 whitespace-normal">
          {node}
        </div>
      </td>
    </tr>
  );
}

function HunkRow({ text, span }: { text: string; span: number }) {
  return (
    <tr className="bg-diff-hunk text-diff-hunk-text">
      <td colSpan={span} className="px-3 py-0.5 whitespace-pre">
        {text}
      </td>
    </tr>
  );
}

/**
 * A unified diff: green added lines, red removed ones, blue hunk headers, with line numbers when hunks give them. With
 * `comments`, hovering an added or unchanged line shows a `+` that opens a comment on it, and threads sit under lines.
 */
export function DiffLines({ lines, comments }: { lines: DiffLine[]; comments?: LineComments }) {
  const rows = numbered(lines);
  const numbers = rows.some((row) => row.hunk);
  const span = numbers ? 4 : 2;
  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <tbody>
          {rows.map((row, index) =>
            row.hunk ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no id
              <HunkRow key={index} text={row.text} span={span} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no id
              <Fragment key={index}>
                <tr className={`group ${LOOK[row.sign].row}`}>
                  {numbers && (
                    <>
                      <td className={`${GUTTER} ${LOOK[row.sign].gutter}`}>{row.old ?? ''}</td>
                      <td className={`${GUTTER} ${LOOK[row.sign].gutter}`}>{row.new ?? ''}</td>
                    </>
                  )}
                  <td className={`relative w-px select-none pr-1 pl-3 align-top ${LOOK[row.sign].sign}`}>
                    {SIGN[row.sign]}
                    {comments && row.new !== null && (
                      <button
                        type="button"
                        aria-label={`Comment on line ${row.new}`}
                        title="Add a comment on this line"
                        onClick={() => comments.onAdd(row.new as number)}
                        className="absolute top-1/2 left-0.5 z-10 hidden size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border-0 bg-diff-hunk-text p-0 font-body text-sm leading-none font-semibold text-white shadow-sm group-hover:flex hover:scale-110"
                      >
                        +
                      </button>
                    )}
                  </td>
                  <td className="pr-4 whitespace-pre">{row.text}</td>
                </tr>
                {comments && row.new !== null && <Below span={span} node={comments.below(row.new)} />}
              </Fragment>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

type Pair = { hunk: string } | { left: Row | null; right: Row | null };

/** Removed lines face the added lines that replace them; unchanged lines sit on both sides. */
function paired(rows: Row[]): Pair[] {
  const out: Pair[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index] as Row;
    if (row.hunk) {
      out.push({ hunk: row.text });
      index++;
    } else if (row.sign === ' ') {
      out.push({ left: row, right: row });
      index++;
    } else {
      const removed: Row[] = [];
      const added: Row[] = [];
      while (rows[index]?.sign === '-' && !rows[index]?.hunk) removed.push(rows[index++] as Row);
      while (rows[index]?.sign === '+') added.push(rows[index++] as Row);
      for (let at = 0; at < Math.max(removed.length, added.length); at++) {
        out.push({ left: removed[at] ?? null, right: added[at] ?? null });
      }
    }
  }
  return out;
}

function Half({ row, side }: { row: Row | null; side: 'old' | 'new' }) {
  if (!row) return <td colSpan={3} className="bg-neutral-200/60" />;
  const look = LOOK[row.sign];
  return (
    <>
      <td className={`${GUTTER} ${look.gutter}`}>{side === 'old' ? row.old : row.new}</td>
      <td className={`w-px select-none pr-1 pl-1.5 align-top ${look.row} ${look.sign}`}>{SIGN[row.sign]}</td>
      <td className={`w-1/2 pr-3 whitespace-pre-wrap break-all ${look.row}`}>{row.text}</td>
    </>
  );
}

/** The old file on the left, the new on the right, line against line. */
export function SplitDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="overflow-x-auto">
      <table className={`${TABLE} table-fixed`}>
        <colgroup>
          <col className="w-12" />
          <col className="w-5" />
          <col />
          <col className="w-12" />
          <col className="w-5" />
          <col />
        </colgroup>
        <tbody>
          {paired(numbered(lines)).map((pair, index) =>
            'hunk' in pair ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no id
              <HunkRow key={index} text={pair.hunk} span={6} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no id
              <tr key={index} className="border-line">
                <Half row={pair.left} side="old" />
                <Half row={pair.right} side="new" />
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The whole new file, its added lines green and removed lines shown red where they were. */
export function FullFileDiff({ lines, text }: { lines: DiffLine[]; text: string }) {
  const rows = numbered(lines).filter((row) => !row.hunk);
  const added = new Set(rows.flatMap((row) => (row.sign === '+' && row.new !== null ? [row.new] : [])));
  const removed = new Map<number, Row[]>();
  for (const row of rows) if (row.sign === '-') removed.set(row.at, [...(removed.get(row.at) ?? []), row]);
  const file = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const out: { key: string; sign: DiffLine['sign']; number: number | null; text: string }[] = [];
  const removedAt = (at: number) => {
    for (const [index, row] of (removed.get(at) ?? []).entries()) {
      out.push({ key: `-${at}-${index}`, sign: '-', number: row.old, text: row.text });
    }
  };
  file.forEach((line, index) => {
    removedAt(index + 1);
    out.push({ key: String(index + 1), sign: added.has(index + 1) ? '+' : ' ', number: index + 1, text: line });
  });
  removedAt(file.length + 1);
  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <tbody>
          {out.map((line) => (
            <tr key={line.key} className={LOOK[line.sign].row}>
              <td className={`${GUTTER} ${LOOK[line.sign].gutter}`}>{line.number}</td>
              <td className={`w-px select-none pr-1 pl-2 align-top ${LOOK[line.sign].sign}`}>{SIGN[line.sign]}</td>
              <td className="pr-4 whitespace-pre">{line.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `+12 −3` with a five-block bar of the split, as Git hosts show it. */
export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  // Each side that changed keeps at least one block.
  const added =
    total === 0
      ? 0
      : Math.min(deletions > 0 ? 4 : 5, Math.max(additions > 0 ? 1 : 0, Math.round((additions / total) * 5)));
  return (
    <span className="inline-flex flex-none items-center gap-1.5 font-mono text-xs">
      <span className="font-semibold text-diff-add-text">+{additions}</span>
      <span className="font-semibold text-diff-del-text">−{deletions}</span>
      <span aria-hidden className="flex gap-px">
        {[0, 1, 2, 3, 4].map((block) => (
          <span
            key={block}
            className={`size-2 rounded-[1px] ${total === 0 ? 'bg-neutral-300' : block < added ? 'bg-ok' : 'bg-accent-500'}`}
          />
        ))}
      </span>
    </span>
  );
}
