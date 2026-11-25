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

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The address when it is an absolute http, https or mailto one; null for anything else, `javascript:` included. */
export function safeHref(href: string): string | null {
  try {
    return LINK_SCHEMES.has(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

const CODE = /(`+)([\s\S]*?[^`])\1(?!`)/y;
const IMAGE = /!\[([^\]]*)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\s*\)/y;
const LINK = /\[((?:[^[\]]|\[[^\]]*\])+)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\s*\)/y;
const STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/y;
const DEL = /~~(?=\S)([\s\S]*?\S)~~/y;
const EM_STAR = /\*(?=[^\s*])([\s\S]*?[^\s*])\*/y;
const EM_UNDERSCORE = /_(?=[^\s_])([\s\S]*?[^\s_])_(?![A-Za-z0-9])/y;
const URL_TEXT = /https?:\/\/[^\s<>`]+/y;
const TRAILING = /[.,;:!?)\]'"]+$/;

function sticky(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** One inline element read at `at`: the node and the length it took, or null when none starts there. */
function inlineAt(text: string, at: number): [Inline[], number] | null {
  const char = text[at];
  const rule = (pattern: RegExp) => sticky(pattern, text, at);
  if (char === '`') {
    const code = rule(CODE);
    return code ? [[{ t: 'code', text: (code[2] ?? '').trim() }], code[0].length] : null;
  }
  if (char === '!') {
    const image = rule(IMAGE);
    return image ? [[{ t: 'image', alt: image[1] ?? '', src: image[2] ?? '' }], image[0].length] : null;
  }
  if (char === '[') {
    const link = rule(LINK);
    if (!link) return null;
    const href = safeHref(link[2] ?? '');
    const children = parseInline(link[1] ?? '');
    return [href ? [{ t: 'link', href, children }] : children, link[0].length];
  }
  if (char === '*' || char === '_') {
    const strong = rule(STRONG);
    if (strong) return [[{ t: 'strong', children: parseInline(strong[2] ?? '') }], strong[0].length];
  }
  if (char === '~') {
    const del = rule(DEL);
    if (del) return [[{ t: 'del', children: parseInline(del[1] ?? '') }], del[0].length];
  }
  if (char === '*' || (char === '_' && !/[A-Za-z0-9]/.test(text[at - 1] ?? ''))) {
    const em = rule(char === '*' ? EM_STAR : EM_UNDERSCORE);
    if (em) return [[{ t: 'em', children: parseInline(em[1] ?? '') }], em[0].length];
  }
  if (char === 'h') {
    const found = rule(URL_TEXT);
    const address = found?.[0].replace(TRAILING, '') ?? '';
    const href = safeHref(address);
    if (href) return [[{ t: 'link', href, children: [{ t: 'text', text: address }] }], address.length];
  }
  return null;
}

/** Text with `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, links, images and bare addresses read out of it. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
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
    const read = inlineAt(text, at);
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

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

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
  (line.includes('|') && TABLE_RULE.test(next) && next.includes('-'));

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Reads the list that starts at `lines[from]`; returns it and the index after it. */
function readList(lines: string[], from: number): [Block, number] {
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
        const after = lines.slice(at).find((candidate) => candidate.trim() !== '');
        if (after !== undefined && indentOf(after) > base) {
          body.push('');
          at++;
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
    items.push({ checked: task ? task[1] !== ' ' : null, children: parseLines(body) });
    // A blank line between items does not end the list while the next line is an item of it.
    const next = lines.slice(at).findIndex((candidate) => candidate.trim() !== '');
    if (next > 0 && ITEM.test(lines[at + next] ?? '') && indentOf(lines[at + next] ?? '') === base) at += next;
  }
  return [{ t: 'list', ordered, start: ordered ? Number.parseInt(first?.[2] ?? '1', 10) : 1, items }, at];
}

function parseLines(lines: string[]): Block[] {
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
      out.push({ t: 'heading', level: heading[1]?.length ?? 1, children: parseInline(heading[2] ?? '') });
      at++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ t: 'rule' });
      at++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at] ?? '')) inner.push(QUOTE.exec(lines[at++] ?? '')?.[1] ?? '');
      out.push({ t: 'quote', children: parseLines(inner) });
      continue;
    }
    if (ITEM.test(line)) {
      const [list, next] = readList(lines, at);
      out.push(list);
      at = next;
      continue;
    }
    if (line.includes('|') && TABLE_RULE.test(lines[at + 1] ?? '') && (lines[at + 1] ?? '').includes('-')) {
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
