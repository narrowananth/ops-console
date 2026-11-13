import {
  fileToken,
  type Message,
  namesInText,
  type OutputFile,
  type Part,
  splitAttachments,
} from '@ops-console/shared';
import { useState } from 'react';
import { AttachmentViewer, outputAddress, PaperClip, size, type Viewed } from '../components/ui/attachment-viewer';
import { Button, Spinner } from '../components/ui/button';
import { CodeBlock } from '../components/ui/code-block';
import { DiffLines } from '../components/ui/diff';
import { Elapsed } from '../components/ui/elapsed';
import { Markdown } from '../components/ui/markdown';
import type { PathwayState } from '../components/ui/pathway';
import { ComparisonView, ResultView } from '../devtools/result-tables';
import { COPY_FAILED, copyLabel, useCopy } from '../lib/clipboard';
import { when } from '../monitor/scan-scope';
import { KindBadge } from '../skills/kind-badge';
import { InlineText } from './inline-text';
import { asReport, ReportDocument } from './report-document';
import { SpawnCard } from './spawn-card';
import { StepRun } from './step-run';

/** One part of a Session's transcript: text, a tool step, a diff, a code block, a question or a Dev tools table. */
function PartView({ part, sessionId }: { part: Part; sessionId: string | null }) {
  if (part.kind === 'spawn') return sessionId === null ? null : <SpawnCard part={part} sessionId={sessionId} />;
  if (part.kind === 'result') return <ResultView part={part} connections={[]} />;
  if (part.kind === 'comparison') return <ComparisonView part={part} />;
  if (part.kind === 'text') {
    const report = asReport(part.text);
    return report ? <ReportDocument report={report} /> : <Markdown source={part.text} />;
  }
  if (part.kind === 'step') return null;
  if (part.kind === 'code') {
    const report = asReport(part.text);
    if (report) return <ReportDocument report={report} />;
    return <CodeBlock text={part.text} className="m-0 overflow-x-auto rounded-md bg-surface p-2.5 font-mono text-xs" />;
  }
  if (part.kind === 'diff') {
    return (
      <div className="overflow-hidden rounded-md border border-line font-mono text-xs">
        <div className="border-b border-line bg-surface px-2 py-1 font-semibold">{part.file}</div>
        <DiffLines lines={part.lines} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-accent-100 px-3.5 py-2.5 text-[13px] text-accent-900">
      {part.header && <span className="text-xs font-semibold tracking-wide uppercase">{part.header}</span>}
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

/** A message sent with a skill: its name and kind, and that the Playbook did not run for it. */
function SkillChip({ skill }: { skill: NonNullable<Message['skill']> }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-700">
      <span className="font-mono font-semibold text-text">/{skill.name}</span>
      <KindBadge kind={skill.kind} name={skill.name} />
      <span>Playbook not used for this message</span>
    </div>
  );
}

/**
 * One message. The operator's messages have Copy; the last one also has Edit, given `onEdit`, which reruns the edited
 * text after putting back the files the agent edited since it.
 */
export function MessageView({
  message,
  onEdit,
  outputs,
}: {
  message: Message;
  onEdit?: (text: string) => Promise<unknown>;
  /** The files the agent wrote during this message's turn, and the Session they belong to. */
  outputs?: { sessionId: string; files: OutputFile[] };
}) {
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
        <span className="text-xs tracking-[0.08em] text-neutral-700 uppercase">
          {agent ? 'Agent' : 'You'}
          {message.status === 'streaming' && ' · working'}
          {message.status === 'failed' && ' · failed'}
        </span>
        {/* The run's in-flight message starts with the run, so its age is how long the agent has worked. */}
        {message.status === 'streaming' && <Elapsed from={message.created_at} to={null} running className="ml-1" />}
        {/* When the prompt ran, or the agent's turn began. */}
        {/* An entry with no timestamp reads as the epoch: it shows none. */}
        {Date.parse(message.created_at) > 0 && (
          <time
            dateTime={message.created_at}
            title={new Date(message.created_at).toLocaleString()}
            className="ml-2 text-xs text-neutral-600 normal-case tracking-normal"
          >
            {when(message.created_at)}
          </time>
        )}
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
          <>
            <MessageParts message={message} sessionId={outputs?.sessionId ?? null} />
            {outputs && message.status !== 'streaming' && <OutputChips {...outputs} />}
          </>
        ) : (
          <>
            {message.skill && <SkillChip skill={message.skill} />}
            <SentText text={text} />
          </>
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

/**
 * The operator's message: its text with a chip where each file sat in it, then a chip for any file not placed in the
 * text. A chip opens its file over the page.
 */
function SentText({ text }: { text: string }) {
  const sent = splitAttachments(text);
  const [viewed, setViewed] = useState<Viewed | null>(null);
  const byName = new Map(sent.attachments.map((file) => [file.name, file]));
  const placed = new Set(namesInText(sent.text).filter((name) => byName.has(name)));
  const open = (file: { name: string; path: string }) => setViewed({ name: file.name, path: file.path });
  const rest = sent.attachments.filter((file) => !placed.has(file.name));
  return (
    <>
      {sent.text &&
        (placed.size === 0 ? (
          <Markdown source={sent.text} />
        ) : (
          <p className="m-0 text-sm leading-relaxed break-words whitespace-pre-wrap">
            {sent.text.split(FILE_TOKEN_SPLIT).map((piece, index) => {
              const file = index % 2 === 1 ? byName.get(piece) : undefined;
              if (index % 2 === 1 && !file) return fileToken(piece);
              return file ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: one file may sit twice; pieces never reorder
                <FileChip key={`${file.path}-${index}`} name={file.name} onOpen={() => open(file)} />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: pieces sit by position and never reorder
                <InlineText key={index} text={piece} />
              );
            })}
          </p>
        ))}
      {rest.length > 0 && (
        <ul aria-label="Attached files" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {rest.map((file) => (
            <li key={file.path}>
              <FileChip name={file.name} onOpen={() => open(file)} />
            </li>
          ))}
        </ul>
      )}
      {viewed && <AttachmentViewer viewed={viewed} onClose={() => setViewed(null)} />}
    </>
  );
}

/** Splits text around file tokens: odd pieces are the names. */
const FILE_TOKEN_SPLIT = /\[📎 ([^\]\n]+)\]/;

/** The files the agent wrote for the operator in a turn, each a chip that opens it over the page. */
function OutputChips({ sessionId, files }: { sessionId: string; files: OutputFile[] }) {
  const [viewed, setViewed] = useState<Viewed | null>(null);
  if (files.length === 0) return null;
  return (
    <>
      <ul aria-label="Output files" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {files.map((file) => (
          <li key={file.name} className="flex items-center gap-1">
            <FileChip
              name={file.name}
              onOpen={() => setViewed({ name: file.name, address: outputAddress(sessionId, file.name) })}
            />
            <span className="font-mono text-xs text-neutral-700">{size(file.size)}</span>
          </li>
        ))}
      </ul>
      {viewed && <AttachmentViewer viewed={viewed} onClose={() => setViewed(null)} />}
    </>
  );
}

/**
 * Gives each output file to the agent message of the turn that wrote it: the last agent message that started at or
 * before the file's last change.
 */
export function outputsByMessage(messages: Message[], files: OutputFile[]): Map<string, OutputFile[]> {
  const turns = messages.filter((message) => message.role === 'agent');
  const byMessage = new Map<string, OutputFile[]>();
  for (const file of files) {
    const owner = turns.findLast((message) => message.created_at <= file.modified_at) ?? turns[0];
    if (owner) byMessage.set(owner.id, [...(byMessage.get(owner.id) ?? []), file]);
  }
  return byMessage;
}

function FileChip({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      title={`Open ${name}`}
      onClick={onOpen}
      className="mx-0.5 inline-flex max-w-72 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-bg px-1.5 py-0.5 align-middle font-mono text-xs text-neutral-800 hover:border-accent-300 hover:text-text"
    >
      <PaperClip />
      <span className="min-w-0 truncate">{name}</span>
    </button>
  );
}

/**
 * The parts in order, each run of tool steps drawn as one compact path. While the message streams, its last step
 * turns; on a failed message, it is crossed.
 */
function MessageParts({ message, sessionId }: { message: Message; sessionId: string | null }) {
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
      return first ? <PartView key={group.at} part={first} sessionId={sessionId} /> : null;
    }
    const tail = index === groups.length - 1;
    const end: PathwayState =
      tail && message.status === 'streaming' ? 'running' : tail && message.status === 'failed' ? 'failed' : 'done';
    return <StepRun key={group.at} end={end} steps={group.parts.map((part) => ('text' in part ? part.text : ''))} />;
  });
}

const messageAction =
  'cursor-pointer rounded-sm border-0 bg-transparent px-1.5 py-0.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-200 hover:text-text';
