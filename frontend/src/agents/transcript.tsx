import { type Message, type Part, splitAttachments } from '@ops-console/shared';
import { useState } from 'react';
import { Button, Spinner } from '../components/ui/button';
import { DiffLines } from '../components/ui/diff';
import { Markdown } from '../components/ui/markdown';
import { Pathway, type PathwayState } from '../components/ui/pathway';
import { ComparisonView, ResultView } from '../devtools/result-tables';
import { COPY_FAILED, copyLabel, useCopy } from '../lib/clipboard';
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
    <div className="flex flex-col gap-1 rounded-lg bg-accent-100 px-3.5 py-2.5 text-[13px] text-accent-900">
      {part.header && <span className="text-[10px] font-bold tracking-wide uppercase">{part.header}</span>}
      <strong>{part.text}</strong>
      {part.options.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-neutral-700">
          {part.options.map((option) => (
            <li key={option.label}>
              <span className="font-semibold">{option.label}</span>
              {option.description && ` — ${option.description}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One message. The operator's messages have Copy; the last one also has Edit, given `onEdit`, which reruns the edited
 * text after putting back the files the agent edited since it.
 */
export function MessageView({ message, onEdit }: { message: Message; onEdit?: (text: string) => Promise<unknown> }) {
  const agent = message.role === 'agent';
  const text = message.parts.map((part) => ('text' in part ? part.text : '')).join('\n');
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, copy] = useCopy();
  const rerun = () => {
    if (!onEdit || draft === null || draft.trim() === '' || pending) return;
    setPending(true);
    setError(null);
    onEdit(draft.trim())
      .then(
        () => setDraft(null),
        (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setPending(false));
  };

  return (
    <li
      aria-label={agent ? undefined : 'Your message'}
      className={`group mx-5 my-2 flex flex-col gap-1.5 rounded-xl px-5 py-3.5 ${agent ? '' : 'border border-line bg-surface'}`}
    >
      <div className="flex min-h-5 items-center gap-1">
        <span className="text-[10px] tracking-[0.08em] text-neutral-700 uppercase">
          {agent ? 'Agent' : 'You'}
          {message.status === 'streaming' && ' · working'}
          {message.status === 'failed' && ' · failed'}
        </span>
        {!agent && draft === null && (
          <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={() => copy(text)}
              title={copied === 'failed' ? COPY_FAILED : 'Copy this message'}
              className={messageAction}
            >
              {copyLabel(copied, 'Copy')}
            </button>
            {onEdit && (
              <button
                type="button"
                onClick={() => setDraft(text)}
                title="Change your last message and run it again. Files the agent edited since are put back first."
                className={messageAction}
              >
                Edit
              </button>
            )}
          </span>
        )}
      </div>
      {draft === null ? (
        agent ? (
          <MessageParts message={message} />
        ) : (
          <SentText text={text} />
        )
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Edit message"
            // biome-ignore lint/a11y/noAutofocus: the operator just asked to edit this text
            autoFocus
            value={draft}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setDraft(null);
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                rerun();
              }
            }}
            className="field-sizing-content max-h-[50vh] min-h-28 w-full resize-y overflow-y-auto rounded-md border border-divider bg-card px-3 py-2 text-sm leading-relaxed text-text outline-none focus:border-accent-400"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-700">
              Puts back the files the agent edited since this message, then runs it again.
            </span>
            <span className="flex-1" />
            <Button className="px-3 py-1 text-xs" disabled={pending} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              className="px-3 py-1 text-xs"
              title="Puts back the files the agent edited since this message, then runs the edited text. ⌘Enter does the same."
              disabled={pending || draft.trim() === ''}
              onClick={rerun}
            >
              {pending && <Spinner />}
              Revert and rerun
            </Button>
          </div>
          {error && (
            <p role="alert" className="m-0 text-xs text-accent-700">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** The operator's message: its text, then a chip per attached file, named, with its saved path on hover. */
function SentText({ text }: { text: string }) {
  const sent = splitAttachments(text);
  return (
    <>
      {sent.text && <Markdown source={sent.text} />}
      {sent.attachments.length > 0 && (
        <ul aria-label="Attached files" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {sent.attachments.map((file) => (
            <li
              key={file.path}
              title={file.path}
              className="max-w-64 truncate rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-neutral-700"
            >
              📎 {file.name}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The parts in order, each run of tool steps drawn as one compact path. While the message streams, its last step
 * turns; on a failed message, it is crossed.
 */
function MessageParts({ message }: { message: Message }) {
  const groups: { at: number; parts: Part[] }[] = [];
  message.parts.forEach((part, at) => {
    const open = groups.at(-1);
    if (part.kind === 'step' && open?.parts[0]?.kind === 'step') open.parts.push(part);
    else groups.push({ at, parts: [part] });
  });
  return groups.map((group, index) => {
    const [first] = group.parts;
    if (first?.kind !== 'step') {
      // Parts stream in order and never reorder: a group's first index is its identity.
      return first ? <PartView key={group.at} part={first} /> : null;
    }
    const tail = index === groups.length - 1;
    const end: PathwayState =
      tail && message.status === 'streaming' ? 'running' : tail && message.status === 'failed' ? 'failed' : 'done';
    return (
      <Pathway
        key={group.at}
        compact
        label="Agent steps"
        steps={group.parts.map((part, position) => ({
          key: String(position),
          title: <span className="text-neutral-700">{'text' in part ? part.text : ''}</span>,
          state: position === group.parts.length - 1 ? end : 'done',
        }))}
      />
    );
  });
}

const messageAction =
  'cursor-pointer rounded-sm border-0 bg-transparent px-1.5 py-0.5 text-[11px] font-semibold text-neutral-700 hover:bg-neutral-200 hover:text-text';
