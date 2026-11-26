import { useEffect, useMemo, useRef, useState } from 'react';
import { ResultView } from '../../devtools/result-tables';
import { apiBlob } from '../../lib/api';
import { copyLabel, useCopy } from '../../lib/clipboard';
import { Button } from './button';
import { CodeBlock } from './code-block';
import { DiagramView } from './viewer/diagram-view';
import { asOpsResult, parseJson } from './viewer/json';
import { JsonTree } from './viewer/json-tree';
import { DRAWN, PARSED, RENDER_LIMIT, TEXT_SHOWN, viewKind } from './viewer/kinds';
import { MarkdownView } from './viewer/markdown-view';
import { TableView } from './viewer/table-view';

export const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The daemon's address for a saved file: its path ends `attachments/<session id>/<file>`. */
export function attachmentAddress(path: string): string {
  const [file = '', sessionId = ''] = path.split('/').reverse();
  return `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(file)}`;
}

/** The daemon's address for a file the agent wrote for the operator. */
export const outputAddress = (sessionId: string, name: string) =>
  `/sessions/${encodeURIComponent(sessionId)}/outputs/${encodeURIComponent(name)}`;

/**
 * What the Viewer opens: a file on this page, an attachment saved by the daemon, a file at a daemon address, or text
 * already on the page, such as a code block.
 */
export type Viewed =
  | { name: string; file: File }
  | { name: string; path: string }
  | { name: string; address: string }
  | { name: string; text: string };

const FRAME_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:";
const BODY = 'max-h-[calc(100vh-120px)]';

/** What the daemon or the page holds for a Viewed, as bytes. */
const initialBlob = (viewed: Viewed) =>
  'file' in viewed ? viewed.file : 'text' in viewed ? new Blob([viewed.text], { type: 'text/plain' }) : null;

/** JSON that did not parse: the parser's message and line above the source. */
function ParseError({ message, line, source }: { message: string; line: number; source: string }) {
  return (
    <div className="flex w-full flex-col gap-2 self-start p-4">
      <p role="alert" className="m-0 text-sm text-accent-700">
        Could not read the JSON, line {line}: {message}
      </p>
      <CodeBlock
        text={source}
        tone="light"
        className="m-0 overflow-auto rounded-lg bg-card p-3 font-mono text-xs whitespace-pre-wrap"
      />
    </div>
  );
}

/** A `.json` or `.jsonl` as a tree, or as the Result table when it holds one `ops-result` object. */
function JsonView({ text, lines }: { text: string; lines: boolean }) {
  const parsed = useMemo(() => parseJson(text, lines), [text, lines]);
  if (!parsed.ok) return <ParseError message={parsed.message} line={parsed.line} source={text} />;
  const result = lines ? null : asOpsResult(parsed.value);
  if (result)
    return (
      <div className="w-full self-start p-4">
        <div className="rounded-lg bg-neutral-900 p-3 text-neutral-100">
          <ResultView part={result} connections={[]} />
        </div>
      </div>
    );
  return <JsonTree value={parsed.value} lines={lines} />;
}

/**
 * A file, or a code block's text, opened over the page by its type: a Markdown, JSON, CSV, Mermaid or Graphviz file
 * drawn, with a Source toggle; an image, PDF, HTML or SVG file as itself, in a frame that runs no script and reaches no
 * network; text as text; anything else to download. Escape, Close and a click on the dimmed page close it.
 */
export function AttachmentViewer({ viewed, onClose }: { viewed: Viewed; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [blob, setBlob] = useState<Blob | null>(() => initialBlob(viewed));
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [view, setView] = useState<'rendered' | 'source'>('rendered');
  const [copied, copy] = useCopy();

  useEffect(() => {
    const box = dialog.current;
    if (!box || box.open) return;
    box.showModal();
    return () => box.close();
  }, []);
  useEffect(() => {
    if ('file' in viewed || 'text' in viewed) return;
    apiBlob('address' in viewed ? viewed.address : attachmentAddress(viewed.path)).then(setBlob, (failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [viewed]);
  const kind = blob ? viewKind(blob.type, viewed.name) : null;
  // A drawn type is read whole up to 2 MB; a larger file, and any other text, shows only its first 256 KB as source.
  const cut = blob !== null && (DRAWN.has(kind ?? 'other') ? blob.size > RENDER_LIMIT : blob.size > TEXT_SHOWN);
  const readable = kind === 'text' || (kind !== null && DRAWN.has(kind));
  useEffect(() => {
    if (!blob) return;
    // The daemon never serves HTML or SVG as a page (its type is bytes); the viewer types them to show them, in a frame
    // or an `<img>` that runs no script.
    const made = URL.createObjectURL(
      kind === 'html'
        ? new Blob([blob], { type: 'text/html' })
        : kind === 'svg'
          ? new Blob([blob], { type: 'image/svg+xml' })
          : blob,
    );
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob, kind]);
  useEffect(() => {
    if (!blob || !readable) return;
    (cut ? blob.slice(0, TEXT_SHOWN) : blob).text().then(setText, () => setError('The file could not be read.'));
  }, [blob, cut, readable]);

  // HTML and SVG draw from the file itself, whatever its size; only the types the page parses need it whole.
  const drawn = kind !== null && DRAWN.has(kind) && !(cut && PARSED.has(kind));
  const source = view === 'source' || !drawn;
  const note = cut ? '\n… the rest is cut here. Download shows all of it.' : undefined;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively; the click is the backdrop
    <dialog
      ref={dialog}
      aria-label={viewed.name}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto flex max-h-[calc(100vh-48px)] w-[min(1100px,calc(100vw-48px))] flex-col overflow-hidden rounded-xl border border-line bg-card p-0 text-text shadow-2xl backdrop:bg-neutral-900/55"
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="m-0 min-w-0 flex-1 truncate font-mono text-sm font-semibold">{viewed.name}</h2>
        {blob && <span className="font-mono text-xs text-neutral-700">{size(blob.size)}</span>}
        {drawn && (
          <fieldset aria-label="View" className="m-0 flex rounded-md border border-line p-0.5">
            {(['rendered', 'source'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={view === choice}
                onClick={() => setView(choice)}
                className={`cursor-pointer rounded border-0 px-2 py-0.5 text-xs capitalize ${view === choice ? 'bg-neutral-200 font-semibold text-text' : 'bg-transparent text-neutral-700 hover:text-text'}`}
              >
                {choice}
              </button>
            ))}
          </fieldset>
        )}
        {text !== null && text !== '' && (
          <button
            type="button"
            onClick={() => copy(text)}
            className="cursor-pointer rounded-md border-0 bg-transparent px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 hover:text-text"
          >
            {copyLabel(copied, 'Copy')}
          </button>
        )}
        {url && (
          <a
            href={url}
            download={viewed.name}
            className="rounded-md px-2 py-1 text-xs text-neutral-700 no-underline hover:bg-neutral-200 hover:text-text"
          >
            Download
          </a>
        )}
        <Button className="px-2.5 py-1 text-xs" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="flex min-h-40 flex-1 items-center justify-center overflow-auto bg-bg">
        {error ? (
          <p role="alert" className="m-0 p-6 text-sm text-accent-700">
            Could not open the file: {error}
          </p>
        ) : !url || !kind || (readable && text === null) ? (
          <p className="m-0 p-6 text-sm text-neutral-700">Opening…</p>
        ) : kind === 'image' || (kind === 'svg' && !source) ? (
          <img src={url} alt={viewed.name} className={`${BODY} max-w-full object-contain`} />
        ) : kind === 'pdf' ? (
          <iframe title={viewed.name} src={url} className="h-[calc(100vh-120px)] w-full border-0" />
        ) : kind === 'html' && !source ? (
          // No `allow-*` token: no script, no form, no top navigation, and the page gets an opaque origin. The page's
          // own `csp` also blocks every request it would make, so it cannot call the daemon or any host.
          <iframe
            title={viewed.name}
            src={url}
            sandbox=""
            // @ts-expect-error `csp` is not in React's iframe attributes yet
            csp={FRAME_CSP}
            className="h-[calc(100vh-120px)] w-full border-0 bg-white"
          />
        ) : kind === 'video' ? (
          // biome-ignore lint/a11y/useMediaCaption: an operator's file has no caption track
          <video src={url} controls className={`${BODY} max-w-full`} />
        ) : kind === 'audio' ? (
          // biome-ignore lint/a11y/useMediaCaption: an operator's file has no caption track
          <audio src={url} controls className="m-6 w-full max-w-xl" />
        ) : !source && kind === 'markdown' ? (
          <MarkdownView source={text ?? ''} />
        ) : !source && (kind === 'json' || kind === 'jsonl') ? (
          <JsonView text={text ?? ''} lines={kind === 'jsonl'} />
        ) : !source && (kind === 'csv' || kind === 'tsv') ? (
          <TableView text={text ?? ''} delimiter={kind === 'csv' ? ',' : '\t'} />
        ) : !source && (kind === 'mermaid' || kind === 'dot') ? (
          <DiagramView kind={kind} source={text ?? ''} name={viewed.name} />
        ) : readable ? (
          <CodeBlock
            text={text ?? ''}
            note={note}
            tone="light"
            wrapperClassName="h-full w-full self-start"
            className="m-0 h-full w-full overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap"
          />
        ) : (
          <p className="m-0 p-6 text-sm text-neutral-700">No preview for this kind of file. Download opens it.</p>
        )}
      </div>
    </dialog>
  );
}

export function PaperClip({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="flex-none">
      <path
        d="M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.3-5.3a2.1 2.1 0 0 1 3 3L6.6 10.9a1 1 0 0 1-1.5-1.5L10 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
