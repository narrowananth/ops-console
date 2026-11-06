import type { ReactNode } from 'react';
import { COPY_FAILED, type CopyState, useCopy } from '../../lib/clipboard';

/**
 * Preformatted text with a copy icon in its top right corner. The icon shows on hover and keyboard focus, and always
 * where there is no hover. It copies the whole text exactly as given. No text, no icon.
 */
export function CodeBlock({
  text,
  className = '',
  wrapperClassName = '',
  tone = 'dark',
  note,
}: {
  text: string;
  /** Classes of the `<pre>`. */
  className?: string;
  /** Classes of the box around it. */
  wrapperClassName?: string;
  /** The icon's colors: `dark` on a dark block, `light` on a light one. */
  tone?: 'dark' | 'light';
  /** Shown after the text and never copied. */
  note?: string;
}) {
  const [state, copy] = useCopy();
  return (
    <div className={`group/code relative min-w-0 ${wrapperClassName}`}>
      <pre className={`${className} ${text === '' ? '' : 'pr-10'}`}>
        {text}
        {note}
      </pre>
      {text !== '' && (
        <button
          type="button"
          aria-label="Copy"
          title={state === 'failed' ? COPY_FAILED : state === 'copied' ? 'Copied' : 'Copy'}
          onClick={() => copy(text)}
          className={`absolute top-1.5 right-1.5 flex size-7 cursor-pointer items-center justify-center rounded-md border opacity-0 transition-opacity group-focus-within/code:opacity-100 group-hover/code:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 ${
            tone === 'dark'
              ? 'border-white/20 bg-neutral-800/90 text-neutral-100 hover:bg-neutral-700'
              : 'border-line bg-card text-neutral-800 hover:bg-neutral-200'
          }`}
        >
          <CopyIcon state={state} />
        </button>
      )}
    </div>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function CopyIcon({ state }: { state: CopyState }) {
  if (state === 'copied')
    return (
      <Svg>
        <path d="m3 8.5 3.2 3.2L13 4.5" />
      </Svg>
    );
  if (state === 'failed')
    return (
      <Svg>
        <path d="m4 4 8 8M12 4l-8 8" />
      </Svg>
    );
  return (
    <Svg>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3v5.5A1.5 1.5 0 0 0 3.5 10H4" />
    </Svg>
  );
}
