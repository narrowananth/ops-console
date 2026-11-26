import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { CodeBlock } from '../code-block';
import { type Block, type Inline, parseMarkdown } from './markdown';

const HEADING_CLASS = [
  'text-xl font-semibold',
  'text-lg font-semibold',
  'text-base font-semibold',
  'text-sm font-semibold',
  'text-[13px] font-semibold',
  'text-xs font-semibold',
];

function Inlines({ nodes }: { nodes: Inline[] }): ReactNode {
  return nodes.map((node, index) => {
    // Nodes sit by position and never reorder.
    const key = index;
    if (node.t === 'text') return node.text;
    if (node.t === 'code')
      return (
        <code key={key} className="rounded bg-neutral-200 px-1 font-mono text-xs">
          {node.text}
        </code>
      );
    if (node.t === 'strong' || node.t === 'em' || node.t === 'del') {
      const Tag = node.t;
      return (
        <Tag key={key}>
          <Inlines nodes={node.children} />
        </Tag>
      );
    }
    if (node.t === 'link')
      return (
        <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" className="text-info underline">
          <Inlines nodes={node.children} />
        </a>
      );
    // A remote image is never loaded: its alt text and address stand in.
    return (
      <span key={key} className="text-neutral-700">
        [image{node.alt && `: ${node.alt}`}]{' '}
        <span className="font-mono text-xs break-all">{node.src.slice(0, 200)}</span>
      </span>
    );
  });
}

function Blocks({ blocks, tight = false }: { blocks: Block[]; tight?: boolean }) {
  return blocks.map((block, index) => {
    // Blocks sit by position and never reorder.
    const key = index;
    if (block.t === 'heading') {
      const Heading = `h${Math.min(block.level + 1, 6)}` as 'h2';
      return (
        <Heading key={key} className={`m-0 mt-2 ${HEADING_CLASS[block.level - 1]}`}>
          <Inlines nodes={block.children} />
        </Heading>
      );
    }
    if (block.t === 'paragraph')
      return tight ? (
        <span key={key}>
          <Inlines nodes={block.children} />
        </span>
      ) : (
        <p key={key} className="m-0">
          <Inlines nodes={block.children} />
        </p>
      );
    if (block.t === 'rule') return <hr key={key} className="m-0 border-0 border-t border-line" />;
    if (block.t === 'quote')
      return (
        <blockquote key={key} className="m-0 flex flex-col gap-2 border-l-3 border-line pl-3 text-neutral-700">
          <Blocks blocks={block.children} />
        </blockquote>
      );
    if (block.t === 'code')
      return (
        <CodeBlock
          key={key}
          text={block.text}
          className="m-0 overflow-auto rounded-lg bg-neutral-900 p-3 font-mono text-xs text-neutral-100"
        />
      );
    if (block.t === 'list') {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List
          key={key}
          start={block.ordered ? block.start : undefined}
          className={`m-0 flex flex-col gap-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
        >
          {block.items.map((item, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items sit by position and never reorder
            <li key={at} className={item.checked === null ? '' : 'list-none'}>
              {item.checked !== null && (
                <input
                  type="checkbox"
                  checked={item.checked}
                  disabled
                  aria-label={item.checked ? 'Done' : 'Not done'}
                  className="mr-1.5 -ml-5 align-middle"
                />
              )}
              <Blocks blocks={item.children} tight />
            </li>
          ))}
        </List>
      );
    }
    return (
      <div key={key} className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-surface">
            <tr>
              {block.head.map((cell, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells sit by position and never reorder
                <th key={at} className="border-b border-line px-2.5 py-1.5 text-left font-semibold">
                  <Inlines nodes={cell} />
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
                    <Inlines nodes={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  });
}

/** A Markdown file drawn as text and elements: no HTML runs and no remote address loads. */
export function MarkdownView({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <article className="flex w-full max-w-3xl flex-col gap-3 self-start p-6 text-sm leading-relaxed">
      <Blocks blocks={blocks} />
    </article>
  );
}
