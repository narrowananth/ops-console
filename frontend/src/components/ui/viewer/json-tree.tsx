import { useState } from 'react';
import { Button } from '../button';

type Mode = 'first' | 'all' | 'none';

const isBranch = (value: unknown): value is object => typeof value === 'object' && value !== null;

function Leaf({ value }: { value: unknown }) {
  if (typeof value === 'string') return <span className="text-ok break-words">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="text-warn">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-skill">{String(value)}</span>;
  return <span className="text-neutral-600 italic">null</span>;
}

function Node({
  name,
  value,
  depth,
  mode,
  lines,
}: {
  name: string | null;
  value: unknown;
  depth: number;
  mode: Mode;
  /** The list holds JSON Lines: its entries are named by their line. */
  lines: boolean;
}) {
  const [open, setOpen] = useState(mode === 'all' || (mode === 'first' && depth === 0));
  const label =
    name === null ? null : (
      <>
        <span className="text-info">{name}</span>
        <span className="text-neutral-600">: </span>
      </>
    );
  if (!isBranch(value))
    return (
      <div className="pl-4">
        {label}
        <Leaf value={value} />
      </div>
    );
  const list = Array.isArray(value);
  const entries = list
    ? value.map((item, at): [string, unknown] => [lines && depth === 0 ? `line ${at + 1}` : String(at), item])
    : Object.entries(value);
  const [start, end] = list ? ['[', ']'] : ['{', '}'];
  const count = `${entries.length} ${list ? 'item' : 'key'}${entries.length === 1 ? '' : 's'}`;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-xs text-text"
      >
        <span aria-hidden className="inline-block w-4 text-neutral-600">
          {open ? '▾' : '▸'}
        </span>
        {label}
        {start}
        {!open && <span className="text-neutral-600"> {count} </span>}
        {!open && end}
      </button>
      {open && (
        <>
          <div className="pl-4">
            {entries.map(([key, child]) => (
              <Node key={key} name={key} value={child} depth={depth + 1} mode={mode} lines={lines} />
            ))}
          </div>
          <div className="pl-4">{end}</div>
        </>
      )}
    </div>
  );
}

/** A JSON value as a tree: its first level open, each branch a click, and keys, strings, numbers and nulls in their own colours. */
export function JsonTree({ value, lines = false }: { value: unknown; lines?: boolean }) {
  // A new key remounts the tree, so every branch takes the new mode.
  const [state, setState] = useState<{ mode: Mode; version: number }>({ mode: 'first', version: 0 });
  const set = (mode: Mode) => setState({ mode, version: state.version + 1 });
  return (
    <div className="flex w-full flex-col self-start">
      <div className="sticky top-0 z-10 flex gap-2 border-b border-line bg-bg px-4 py-2">
        <Button className="px-2.5 py-1 text-xs" onClick={() => set('all')}>
          Expand all
        </Button>
        <Button className="px-2.5 py-1 text-xs" onClick={() => set('none')}>
          Collapse all
        </Button>
      </div>
      <div className="overflow-auto p-4 font-mono text-xs leading-relaxed">
        <Node key={state.version} name={null} value={value} depth={0} mode={state.mode} lines={lines} />
      </div>
    </div>
  );
}
