import type { Message, Part } from '@ops-console/shared';
import { DiffLines } from '../components/ui/diff';
import { Markdown } from '../components/ui/markdown';
import { ComparisonView, ResultView } from '../devtools/result-tables';
import { asReport, ReportDocument } from './report-document';

/** One part of a Session's transcript: text, a tool step, a diff, a code block, a question or a Dev tools table. */
function PartView({ part }: { part: Part }) {
  if (part.kind === 'result') return <ResultView part={part} connections={[]} />;
  if (part.kind === 'comparison') return <ComparisonView part={part} />;
  if (part.kind === 'text') {
    const report = asReport(part.text);
    return report ? <ReportDocument report={report} /> : <Markdown source={part.text} />;
  }
  if (part.kind === 'step') return <div className="font-mono text-xs text-neutral-700">{part.text}</div>;
  if (part.kind === 'code') {
    const report = asReport(part.text);
    if (report) return <ReportDocument report={report} />;
    return <pre className="m-0 overflow-x-auto rounded-md bg-surface p-2.5 font-mono text-xs">{part.text}</pre>;
  }
  if (part.kind === 'diff') {
    return (
      <div className="overflow-hidden rounded-md border border-line font-mono text-xs">
        <div className="border-b border-line bg-surface px-2 py-1 font-bold">{part.file}</div>
        <DiffLines lines={part.lines} />
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-accent-100 px-3.5 py-2.5 text-[13px] text-accent-900">
      <strong>{part.text}</strong>
      {part.options.length > 0 && <div className="text-xs text-neutral-700">{part.options.join(' · ')}</div>}
    </div>
  );
}

export function MessageView({ message }: { message: Message }) {
  const agent = message.role === 'agent';
  return (
    <li
      className={`mx-5 my-2 flex flex-col gap-1.5 rounded-xl px-5 py-3.5 ${agent ? '' : 'border border-line bg-surface'}`}
    >
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
