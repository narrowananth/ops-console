/**
 * A small Markdown reader for the Viewer. It makes a tree of text and never of HTML: raw HTML stays text, an image is
 * its alt text and address, and a link keeps its address only when it is http, https or mailto.
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'del'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] }
  | { t: 'image'; alt: string; src: string };

export type ListItem = { checked: boolean | null; children: Block[] };
export type Block =
  | { t: 'heading'; level: number; children: Inline[] }
  | { t: 'paragraph'; children: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'quote'; children: Block[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'rule' };

/** Quotes and lists inside each other read this deep; deeper lines stay text, so a hostile file cannot exhaust the stack. */
const MAX_NESTING = 8;
/** A link or image reads at most this many characters, so an opener with no end costs a bounded look. */
const SPAN_WINDOW = 1000;

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The address when it is an absolute http, https or mailto one; null for anything else, `javascript:` included. */
export function safeHref(href: string): string | null {
  try {
    return LINK_SCHEMES.has(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

const IMAGE = /!\[([^\]]*)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\s*\)/y;
const LINK = /\[((?:[^[\]]|\[[^\]]*\])+)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\s*\)/y;
// A span's opener is checked in `inlineAt` (what must follow it), so a failed search means no closer exists.
const STRONG = /(\*\*|__)([\s\S]*?\S)\1/y;
const DEL = /~~([\s\S]*?\S)~~/y;
const EM_STAR = /\*([\s\S]*?[^\s*])\*/y;
const EM_UNDERSCORE = /_([\s\S]*?[^\s_])_(?![A-Za-z0-9])/y;
const URL_TEXT = /https?:\/\/[^\s<>`]+/y;
const TRAILING = new Set('.,;:!?)]\'"');

function sticky(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** What one `parseInline` call learns as it reads, so no opener makes it look at the same text again. */
type Scan = {
  /** Where the search for a kind of closer found none: no later opener of that kind has one either. */
  failed: Map<string, number>;
  /** Where each run of backticks starts, by the run's length. */
  runs: Map<number, number[]> | null;
  /** The next `](` found, or -1 when no more follow: a link or image has one close after its opener. */
  middle: number | null;
  /** Where the last address that is no link ends: the `h` of another `http` inside it starts no new one. */
  addressSkip: number;
};

/** The span that opens at `at`, searched to its closer once per kind until a search finds none. */
function span(scan: Scan, kind: string, pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  if ((scan.failed.get(kind) ?? Number.POSITIVE_INFINITY) <= at) return null;
  const found = sticky(pattern, text, at);
  if (!found) scan.failed.set(kind, at);
  return found;
}

/** The link or image that opens at `at`, read through a bounded window and only when a `](` is near. */
function linkAt(pattern: RegExp, text: string, at: number, scan: Scan): RegExpExecArray | null {
  if (scan.middle === null || (scan.middle !== -1 && scan.middle < at)) scan.middle = text.indexOf('](', at);
  if (scan.middle === -1 || scan.middle - at > SPAN_WINDOW) return null;
  return sticky(pattern, text.slice(at, at + SPAN_WINDOW), 0);
}

const solid = (char: string | undefined, not = ''): boolean => char !== undefined && char !== not && !/\s/.test(char);

function backtickRuns(text: string): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  for (let at = text.indexOf('`'); at !== -1; ) {
    let end = at;
    while (text[end] === '`') end++;
    const starts = runs.get(end - at) ?? [];
    starts.push(at);
    runs.set(end - at, starts);
    at = text.indexOf('`', end);
  }
  return runs;
}

/** A code span: a run of backticks to the next run of the same length; with none, the run is text. */
function codeAt(text: string, at: number, scan: Scan): [Inline[], number] {
  let end = at;
  while (text[end] === '`') end++;
  const size = end - at;
  scan.runs ??= backtickRuns(text);
  const starts = scan.runs.get(size) ?? [];
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((starts[mid] ?? 0) < end) low = mid + 1;
    else high = mid;
  }
  const close = starts[low];
  if (close === undefined) return [[{ t: 'text', text: '`'.repeat(size) }], size];
  return [[{ t: 'code', text: text.slice(end, close).trim() }], close + size - at];
}

/** One inline element read at `at`: the node and the length it took, or null when none starts there. */
function inlineAt(text: string, at: number, scan: Scan): [Inline[], number] | null {
  const char = text[at];
  if (char === '`') return codeAt(text, at, scan);
  if (char === '!') {
    const image = linkAt(IMAGE, text, at, scan);
    return image ? [[{ t: 'image', alt: image[1] ?? '', src: image[2] ?? '' }], image[0].length] : null;
  }
  if (char === '[') {
    const link = linkAt(LINK, text, at, scan);
    if (!link) return null;
    const href = safeHref(link[2] ?? '');
    const children = parseInline(link[1] ?? '');
    return [href ? [{ t: 'link', href, children }] : children, link[0].length];
  }
  if ((char === '*' || char === '_') && text[at + 1] === char && solid(text[at + 2])) {
    const strong = span(scan, char + char, STRONG, text, at);
    if (strong) return [[{ t: 'strong', children: parseInline(strong[2] ?? '') }], strong[0].length];
  }
  if (char === '~' && text[at + 1] === '~' && solid(text[at + 2])) {
    const del = span(scan, '~~', DEL, text, at);
    if (del) return [[{ t: 'del', children: parseInline(del[1] ?? '') }], del[0].length];
  }
  if (char === '*' || (char === '_' && !/[A-Za-z0-9]/.test(text[at - 1] ?? ''))) {
    if (solid(text[at + 1], char)) {
      const em = span(scan, char, char === '*' ? EM_STAR : EM_UNDERSCORE, text, at);
      if (em) return [[{ t: 'em', children: parseInline(em[1] ?? '') }], em[0].length];
    }
  }
  if (char === 'h' && at >= scan.addressSkip) {
    const found = sticky(URL_TEXT, text, at)?.[0];
    if (found) {
      let stop = found.length;
      while (stop > 0 && TRAILING.has(found[stop - 1] ?? '')) stop--;
      const address = found.slice(0, stop);
      const href = safeHref(address);
      if (href) return [[{ t: 'link', href, children: [{ t: 'text', text: address }] }], address.length];
      scan.addressSkip = at + found.length;
    }
  }
  return null;
}

/** Text with `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, links, images and bare addresses read out of it. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const scan: Scan = { failed: new Map(), runs: null, middle: null, addressSkip: 0 };
  const push = (node: Inline) => {
    const last = out.at(-1);
    if (node.t === 'text' && last?.t === 'text') last.text += node.text;
    else out.push(node);
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? '';
    if (char === '\\' && /[\\`*_~[\]()!#<>|-]/.test(text[at + 1] ?? '')) {
      push({ t: 'text', text: text[at + 1] ?? '' });
      at += 2;
      continue;
    }
    const read = inlineAt(text, at, scan);
    if (read) {
      for (const node of read[0]) push(node);
      at += read[1];
    } else {
      push({ t: 'text', text: char });
      at++;
    }
  }
  return out;
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const tableRule = (line: string) => TABLE_RULE.test(line.trim());
const TASK = /^\[([ xX])\]\s+(.*)$/;

/** A heading's text without its closing `#`s: `Title ##` reads as `Title`. */
function headingText(raw: string): string {
  const text = raw.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  return end > 0 && end < text.length && /\s/.test(text[end - 1] ?? '') ? text.slice(0, end).trimEnd() : text;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => parseInline(cell.trim().replace(/\\\|/g, '|')));

const opensBlock = (line: string, next: string) =>
  HEADING.test(line) ||
  RULE.test(line) ||
  FENCE.test(line) ||
  QUOTE.test(line) ||
  ITEM.test(line) ||
  (line.includes('|') && tableRule(next) && next.includes('-'));

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The index of the first line at or after `from` that is not blank, or -1. */
function nextFilled(lines: string[], from: number): number {
  for (let at = from; at < lines.length; at++) if ((lines[at] ?? '').trim() !== '') return at;
  return -1;
}

/** Reads the list that starts at `lines[from]`; returns it and the index after it. */
function readList(lines: string[], from: number, depth: number): [Block, number] {
  const first = ITEM.exec(lines[from] ?? '');
  const base = first?.[1]?.length ?? 0;
  const ordered = /\d/.test(first?.[2] ?? '');
  const items: ListItem[] = [];
  let at = from;
  while (at < lines.length) {
    const item = ITEM.exec(lines[at] ?? '');
    if (!item || (item[1]?.length ?? 0) !== base || /\d/.test(item[2] ?? '') !== ordered) break;
    const body: string[] = [item[3] ?? ''];
    at++;
    // The item owns the lines under it that sit deeper, and the blank line between them.
    while (at < lines.length) {
      const line = lines[at] ?? '';
      if (line.trim() === '') {
        const after = nextFilled(lines, at);
        if (after !== -1 && indentOf(lines[after] ?? '') > base) {
          for (; at < after; at++) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(line) <= base) break;
      body.push(line.slice(Math.min(indentOf(line), base + 2)));
      at++;
    }
    const task = TASK.exec(body[0] ?? '');
    if (task) body[0] = task[2] ?? '';
    items.push({ checked: task ? task[1] !== ' ' : null, children: parseLines(body, depth + 1) });
    // A blank line between items does not end the list while the next line is an item of it.
    const next = nextFilled(lines, at);
    if (next > at && ITEM.test(lines[next] ?? '') && indentOf(lines[next] ?? '') === base) at = next;
  }
  return [{ t: 'list', ordered, start: ordered ? Number.parseInt(first?.[2] ?? '1', 10) : 1, items }, at];
}

function parseLines(lines: string[], depth = 0): Block[] {
  const nests = depth < MAX_NESTING;
  const out: Block[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? '';
    if (line.trim() === '') {
      at++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1] ?? '```';
      const text: string[] = [];
      at++;
      while (at < lines.length && !new RegExp(`^ {0,3}${mark[0]}{${mark.length},}\\s*$`).test(lines[at] ?? ''))
        text.push(lines[at++] ?? '');
      at++;
      out.push({ t: 'code', lang: fence[2] ?? '', text: text.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: 'heading', level: heading[1]?.length ?? 1, children: parseInline(headingText(heading[2] ?? '')) });
      at++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ t: 'rule' });
      at++;
      continue;
    }
    if (nests && QUOTE.test(line)) {
      const inner: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at] ?? '')) inner.push(QUOTE.exec(lines[at++] ?? '')?.[1] ?? '');
      out.push({ t: 'quote', children: parseLines(inner, depth + 1) });
      continue;
    }
    if (nests && ITEM.test(line)) {
      const [list, next] = readList(lines, at, depth);
      out.push(list);
      at = next;
      continue;
    }
    if (line.includes('|') && tableRule(lines[at + 1] ?? '') && (lines[at + 1] ?? '').includes('-')) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      at += 2;
      while (at < lines.length && (lines[at] ?? '').trim() !== '' && (lines[at] ?? '').includes('|'))
        rows.push(cells(lines[at++] ?? ''));
      out.push({ t: 'table', head, rows });
      continue;
    }
    const text: string[] = [line.trim()];
    at++;
    while (at < lines.length && (lines[at] ?? '').trim() !== '' && !opensBlock(lines[at] ?? '', lines[at + 1] ?? ''))
      text.push((lines[at++] ?? '').trim());
    out.push({ t: 'paragraph', children: parseInline(text.join('\n')) });
  }
  return out;
}

/** Markdown text as blocks: headings, paragraphs, lists with tasks, tables, quotes, fenced code and rules. */
export function parseMarkdown(source: string): Block[] {
  return parseLines(source.replace(/\r\n?/g, '\n').split('\n'));
}
