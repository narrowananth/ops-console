import type { ReactNode } from 'react';
import { InlineText } from '../../agents/inline-text';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'paragraph'; text: string };

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const TABLE = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

/** A line that starts a block other than a paragraph. */
const opensBlock = (line: string) =>
  HEADING.test(line) ||
  BULLET.test(line) ||
  NUMBERED.test(line) ||
  TABLE.test(line) ||
  QUOTE.test(line) ||
  RULE.test(line) ||
  line.trimStart().startsWith('```');

/** Splits Markdown into the blocks a Report uses: headings, fenced code, lists, tables, quotes, rules and paragraphs. */
function blocks(source: string): Block[] {
  const out: Block[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index++;
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith('```'))
        code.push(lines[index++] ?? '');
      index++;
      out.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: 'rule' });
      index++;
      continue;
    }
    if (TABLE.test(line) && TABLE_RULE.test(lines[index + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && TABLE.test(lines[index] ?? '')) rows.push(cells(lines[index++] ?? ''));
      out.push({ kind: 'table', head, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const text: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? ''))
        text.push(QUOTE.exec(lines[index++] ?? '')?.[1] ?? '');
      out.push({ kind: 'quote', text: text.join(' ') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      index++;
      continue;
    }
    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index] ?? '')) {
        items.push(pattern.exec(lines[index] ?? '')?.[1] ?? '');
        index++;
      }
      out.push({ kind: 'list', ordered, items });
      continue;
    }
    const text: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (next.trim() === '' || opensBlock(next)) break;
      text.push(next.trim());
      index++;
    }
    out.push({ kind: 'paragraph', text: text.join(' ') });
  }
  return out;
}

const HEADING_TAG = ['h2', 'h3', 'h4', 'h5'] as const;

const HEADING_CLASS = [
  '',
  'text-lg font-semibold',
  'text-[15px] font-semibold',
  'text-sm font-semibold',
  'text-[13px] font-semibold',
];

/** Markdown an agent wrote, drawn. Links and images show as written. */
export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const code = 'rounded bg-neutral-200 px-1 text-xs';
  return (
    <div className={`flex min-w-0 flex-col gap-2.5 text-[13px] leading-relaxed ${className}`}>
      {blocks(source).map((block, index): ReactNode => {
        // Blocks sit by position and never reorder.
        const key = index;
        if (block.kind === 'heading') {
          // A Report sits under the page's own headings, so its `#` is an h2.
          const Heading = HEADING_TAG[block.level - 1] ?? 'h5';
          return (
            <Heading key={key} className={`m-0 mt-1 ${HEADING_CLASS[block.level]}`}>
              <InlineText text={block.text} codeClassName={code} />
            </Heading>
          );
        }
        if (block.kind === 'code') {
          return (
            <pre
              key={key}
              className="m-0 overflow-auto rounded-lg bg-neutral-900 p-3 font-mono text-xs text-neutral-100"
            >
              {block.text}
            </pre>
          );
        }
        if (block.kind === 'rule') return <hr key={key} className="m-0 border-0 border-t border-line" />;
        if (block.kind === 'quote') {
          return (
            <blockquote key={key} className="m-0 border-l-3 border-line pl-3 text-neutral-700">
              <InlineText text={block.text} codeClassName={code} />
            </blockquote>
          );
        }
        if (block.kind === 'table') {
          return (
            <div key={key} className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-xs">
                <thead className="bg-surface">
                  <tr>
                    {block.head.map((cell, at) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells sit by position and never reorder
                      <th key={at} className="border-b border-line px-2.5 py-1.5 text-left font-semibold">
                        <InlineText text={cell} codeClassName={code} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, at) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows sit by position and never reorder
                    <tr key={at} className="border-b border-line last:border-0">
                      {row.map((cell, column) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: cells sit by position and never reorder
                        <td key={column} className="px-2.5 py-1.5 align-top">
                          <InlineText text={cell} codeClassName={code} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={key} className={`m-0 flex flex-col gap-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
              {block.items.map((text, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: list items sit by position and never reorder
                <li key={at}>
                  <InlineText text={text} codeClassName={code} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={key} className="m-0">
            <InlineText text={block.text} codeClassName={code} />
          </p>
        );
      })}
    </div>
  );
}
