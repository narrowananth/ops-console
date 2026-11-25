/** A file larger than this shows its first `TEXT_SHOWN` bytes as source, never drawn. */
export const RENDER_LIMIT = 2 * 1024 * 1024;
export const TEXT_SHOWN = 256 * 1024;

export type ViewKind =
  | 'image'
  | 'svg'
  | 'pdf'
  | 'html'
  | 'video'
  | 'audio'
  | 'text'
  | 'markdown'
  | 'json'
  | 'jsonl'
  | 'csv'
  | 'tsv'
  | 'mermaid'
  | 'dot'
  | 'other';

const BY_NAME: [ViewKind, RegExp][] = [
  ['markdown', /\.(md|markdown)$/i],
  ['jsonl', /\.jsonl$/i],
  ['json', /\.json$/i],
  ['csv', /\.csv$/i],
  ['tsv', /\.tsv$/i],
  ['mermaid', /\.(mmd|mermaid)$/i],
  ['dot', /\.(dot|gv)$/i],
  ['svg', /\.svg$/i],
  ['html', /\.html?$/i],
];
const TEXT_NAME =
  /\.(log|sql|txt|xml|ya?ml|toml|ini|env|conf|sh|py|rb|go|rs|java|kt|swift|[cm]?[jt]sx?|css|scss|diff|patch)$/i;

/** How the Viewer shows a file. The daemon serves most of them as bytes, so the name decides before the type does. */
export function viewKind(type: string, name: string): ViewKind {
  const named = BY_NAME.find(([, pattern]) => pattern.test(name));
  if (named) return named[0];
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/html') return 'html';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/') || type === 'application/json' || TEXT_NAME.test(name)) return 'text';
  return 'other';
}

/** Kinds with a drawn view and a Source toggle. */
export const DRAWN: ReadonlySet<ViewKind> = new Set([
  'markdown',
  'json',
  'jsonl',
  'csv',
  'tsv',
  'mermaid',
  'dot',
  'html',
  'svg',
]);

const BLOCK_EXTENSION: Record<string, string> = {
  json: 'json',
  jsonl: 'jsonl',
  csv: 'csv',
  tsv: 'tsv',
  markdown: 'md',
  md: 'md',
  mermaid: 'mmd',
  dot: 'dot',
  html: 'html',
  svg: 'svg',
  'ops-result': 'json',
};

/** The file name the Viewer gives a code block of this language; null when the Viewer has nothing to draw for it. */
export function blockFile(lang: string): string | null {
  const extension = BLOCK_EXTENSION[lang.toLowerCase()];
  return extension ? `block.${extension}` : null;
}
