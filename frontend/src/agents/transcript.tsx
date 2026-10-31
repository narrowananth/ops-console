import type { Message, Part } from '@ops-console/shared';

/** One part of a Session's transcript: text, a tool step, a diff, a code block or a question. */
function PartView({ part }: { part: Part }) {
  if (part.kind === 'text') return <p className="m-0 whitespace-pre-wrap text-[13px]">{part.text}</p>;
  if (part.kind === 'step') return <div className="font-mono text-xs text-neutral-700">{part.text}</div>;
  if (part.kind === 'code') {
    return <pre className="m-0 overflow-x-auto bg-surface p-2 font-mono text-xs">{part.text}</pre>;
  }
  if (part.kind === 'diff') {
    return (
      <div className="border border-divider font-mono text-xs">
        <div className="bg-surface px-2 py-1 font-bold">{part.file}</div>
        {part.lines.map((line, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no id
            key={index}
            className={line.sign === '+' ? 'bg-neutral-200' : line.sign === '-' ? 'bg-accent-100 text-accent-700' : ''}
          >
            {line.sign} {line.text}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="border-l-3 border-accent pl-2 text-[13px]">
      <strong>{part.text}</strong>
      {part.options.length > 0 && <div className="text-xs text-neutral-700">{part.options.join(' · ')}</div>}
    </div>
  );
}

export function MessageView({ message }: { message: Message }) {
  const agent = message.role === 'agent';
  return (
    <li className={`flex flex-col gap-1.5 px-5 py-3 ${agent ? '' : 'bg-surface'}`}>
      <span className="text-[10px] tracking-[0.08em] text-neutral-700 uppercase">
        {agent ? 'Agent' : 'You'}
        {message.status === 'streaming' && ' · working'}
        {message.status === 'failed' && ' · failed'}
      </span>
      {message.parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts stream in order and never reorder
        <PartView key={index} part={part} />
      ))}
    </li>
  );
}
