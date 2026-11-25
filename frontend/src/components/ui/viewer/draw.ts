export type DiagramKind = 'mermaid' | 'dot';

/** The drawing code is not there: it failed to load, as against a source it could not read. */
export class DrawingUnavailable extends Error {}

const loaded = <T>(load: () => Promise<T>): Promise<T> =>
  load().catch((failure: unknown) => {
    throw new DrawingUnavailable(failure instanceof Error ? failure.message : String(failure));
  });

let mermaid: ReturnType<typeof loadMermaid> | undefined;
let viz: ReturnType<typeof loadViz> | undefined;

const loadMermaid = () =>
  loaded(async () => {
    const { default: library } = await import('mermaid');
    // Strict level: no click handlers, and no HTML in labels, so the SVG is shapes and text only.
    library.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
    });
    return library;
  });

const loadViz = () =>
  loaded(async () => {
    const { instance } = await import('@viz-js/viz');
    return instance();
  });

let counter = 0;

/** SVG at its own size: an `<img>` has no page to take a width of 100% from. */
function sized(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const box = root
    .getAttribute('viewBox')
    ?.split(/[\s,]+/)
    .map(Number);
  if (box && box.length === 4 && box.every(Number.isFinite)) {
    root.setAttribute('width', String(box[2]));
    root.setAttribute('height', String(box[3]));
    root.removeAttribute('style');
  }
  return new XMLSerializer().serializeToString(root);
}

/** The diagram as an SVG string. The drawing code loads on the first call. Throws what the parser said when the source does not read. */
export async function draw(kind: DiagramKind, source: string): Promise<string> {
  if (kind === 'mermaid') {
    mermaid ??= loadMermaid();
    const library = await mermaid;
    return sized((await library.render(`diagram-${counter++}`, source)).svg);
  }
  viz ??= loadViz();
  const engine = await viz;
  return sized(engine.renderString(source, { format: 'svg' }));
}
