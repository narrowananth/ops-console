import { useEffect, useRef, useState } from 'react';
import { Button } from '../button';
import { CodeBlock } from '../code-block';
import { type DiagramKind, DrawingUnavailable, draw } from './draw';

type Drawn = { svg: string } | { message: string; unavailable: boolean } | null;

const STEP = 1.25;

/**
 * A Mermaid or Graphviz source drawn as an image, with zoom in, out and fit. A source that does not read shows the
 * parser's message above it; drawing code that did not load shows the source with that note.
 */
export function DiagramView({ kind, source, name }: { kind: DiagramKind; source: string; name: string }) {
  const [drawn, setDrawn] = useState<Drawn>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [natural, setNatural] = useState<number | null>(null);
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setDrawn(null);
    let current = true;
    draw(kind, source).then(
      (svg) => current && setDrawn({ svg }),
      (failure: unknown) =>
        current &&
        setDrawn({
          message: failure instanceof Error ? failure.message : String(failure),
          unavailable: failure instanceof DrawingUnavailable,
        }),
    );
    return () => {
      current = false;
    };
  }, [kind, source]);
  useEffect(() => {
    if (!drawn || !('svg' in drawn)) return;
    const made = URL.createObjectURL(new Blob([drawn.svg], { type: 'image/svg+xml' }));
    setUrl(made);
    setZoom(null);
    return () => URL.revokeObjectURL(made);
  }, [drawn]);

  if (!drawn) return <p className="m-0 p-6 text-sm text-neutral-700">Drawing…</p>;
  if ('message' in drawn)
    return (
      <div className="flex w-full flex-col gap-2 self-start p-4">
        <p role="alert" className="m-0 text-sm text-accent-700">
          {drawn.unavailable ? 'Could not load the drawing code: ' : 'Could not draw it: '}
          {drawn.message}
        </p>
        <CodeBlock
          text={source}
          tone="light"
          className="m-0 overflow-auto rounded-lg bg-card p-3 font-mono text-xs whitespace-pre-wrap"
        />
      </div>
    );
  // Zooming from Fit starts at the size the image has now.
  const scale = (factor: number) => {
    const shown = image.current && natural ? image.current.clientWidth / natural : 1;
    setZoom((zoom ?? shown) * factor);
  };
  return (
    <div className="flex h-full min-h-0 w-full flex-col self-start">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <Button className="px-2.5 py-1 text-xs" aria-label="Zoom in" onClick={() => scale(STEP)}>
          +
        </Button>
        <Button className="px-2.5 py-1 text-xs" aria-label="Zoom out" onClick={() => scale(1 / STEP)}>
          −
        </Button>
        <Button className="px-2.5 py-1 text-xs" aria-label="Fit" onClick={() => setZoom(null)}>
          Fit
        </Button>
        <span className="font-mono text-xs text-neutral-700">
          {zoom === null ? 'Fit' : `${Math.round(zoom * 100)}%`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-white p-4">
        {url && (
          <img
            ref={image}
            src={url}
            alt={name}
            onLoad={(event) => setNatural(event.currentTarget.naturalWidth)}
            style={zoom !== null && natural !== null ? { width: natural * zoom } : undefined}
            className={zoom === null ? 'mx-auto max-h-[calc(100vh-200px)] max-w-full object-contain' : 'max-w-none'}
          />
        )}
      </div>
    </div>
  );
}
