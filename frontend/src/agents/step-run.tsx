import { useState } from 'react';
import { Pathway, type PathwayState } from '../components/ui/pathway';

const LONGEST = 72;

/**
 * What a tool step says to the operator: `$ git add -A && git commit …` is "Ran git add +1", and a long path keeps
 * its last two folders. The full text stays on hover.
 */
export function stepLabel(text: string): string {
  if (text.startsWith('$ ')) {
    const parts = text
      .slice(2)
      .split(/&&|\|\||;|\n/)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const words = (parts[0] ?? '').split(/\s+/).filter((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word));
    const [program = '', next = ''] = words;
    const shown = /^[a-z][\w-]*$/.test(next) && next !== '' ? `${program} ${next}` : program;
    return `Ran ${shown}${parts.length > 1 ? ` +${parts.length - 1}` : ''}`;
  }
  const short = text.replace(/\/\S+/g, (path) => {
    const folders = path.split('/').filter(Boolean);
    return folders.length > 3 ? `…/${folders.slice(-2).join('/')}` : path;
  });
  return short.length > LONGEST ? `${short.slice(0, LONGEST - 1)}…` : short;
}

/**
 * A run of the agent's tool steps, folded to one line: how many, and the latest. Open, each step is one short line.
 * The commands themselves are on hover; the conversation reads the agent's words, not its shell.
 */
export function StepRun({ steps, end }: { steps: string[]; end: PathwayState }) {
  const [open, setOpen] = useState(false);
  const latest = steps.at(-1) ?? '';
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}
        onClick={() => setOpen((now) => !now)}
        className="-ml-1 flex min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-xs text-neutral-700 hover:bg-neutral-200"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
          className={`flex-none text-neutral-600 transition-transform ${open ? '' : '-rotate-90'}`}
        >
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="flex-none font-semibold">
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
        </span>
        {!open && (
          <span className="min-w-0 truncate" title={latest}>
            · {stepLabel(latest)}
          </span>
        )}
        {end === 'running' && (
          <span
            aria-hidden
            className="size-3 flex-none animate-spin rounded-full border-2 border-accent border-t-transparent"
          />
        )}
        {end === 'failed' && <span className="flex-none font-semibold text-accent-700">failed</span>}
      </button>
      {open && (
        <Pathway
          compact
          label="Agent steps"
          steps={steps.map((text, position) => ({
            key: String(position),
            title: (
              <span className="block max-w-full truncate text-neutral-700" title={text}>
                {stepLabel(text)}
              </span>
            ),
            state: position === steps.length - 1 ? end : 'done',
          }))}
        />
      )}
    </div>
  );
}
