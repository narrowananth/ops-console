import {
  type EditedMessage,
  FILE_TOKEN,
  fileToken,
  type Message,
  namesInText,
  type Repo,
  type Session,
  SessionKind,
  SessionState,
  type SkillRef,
  withAttachments,
  withElementPicks,
} from '@ops-console/shared';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { ApprovalPrompts } from '../agents/approval-prompts';
import { PlayRun } from '../agents/play-run';
import { QuestionPanel, trailingQuestions } from '../agents/question-panel';
import { StopRun } from '../agents/stop-run';
import { useIncomingPicks } from '../browser/element-picks';
import { AttachmentViewer, type Viewed } from '../components/ui/attachment-viewer';
import { useRunQueue, useSendMessage, warmSession } from '../lib/queries';
import { useStored } from '../lib/remember';
import { AttachButton, filesIn, useAttachments } from './attachments';
import { type ComposerCommand, useComposerMenus } from './composer-menus';
import { ComposerSettings } from './composer-settings';
import { ExtraRepos } from './extra-repos';
import { sessionDraftKey } from './links';
import { MessageEditor, type MessageEditorHandle } from './message-editor';
import { type PastedText, PastedTextEditor } from './pasted-text-editor';
import { PickedChips, useElementPicks } from './picked-elements';

/**
 * Everything below the conversation: the Approval prompts, the question panel, the queued message and the message box.
 * The draft lives here, so a key redraws this and not the conversation above it.
 */
export function SessionComposer({
  session,
  repos,
  lastMessage,
  commands: sessionCommands,
  reverted,
  onSent,
  onRevertedClose,
}: {
  session: Session;
  repos: Repo[];
  /** The conversation's last message: a question the agent ended on is answered here. */
  lastMessage: Message | undefined;
  /** What the `/` menu lists besides `skills` and `files`: the actions of the Session's view. */
  commands: ComposerCommand[];
  /** What the last edit did to the files, until the operator closes it or sends again. */
  reverted: EditedMessage | null;
  onSent: () => void;
  onRevertedClose: () => void;
}) {
  const id = session.id;
  const send = useSendMessage(id);
  // What the operator typed while the agent was working: the daemon keeps it and sends it when the run ends, unless the
  // operator stops the run, which holds it for Send now.
  const queue = useRunQueue(id);
  const [text, setText] = useStored(sessionDraftKey(id), z.string(), '', 'typing');
  const [picked, setPicked] = useState<SkillRef | null>(null);
  const attachments = useAttachments(id);
  const elements = useElementPicks(id, attachments);
  const editor = useRef<MessageEditorHandle>(null);
  // An attached file open over the page.
  const [viewed, setViewed] = useState<Viewed | null>(null);
  // A pasted text file open to edit.
  const [editing, setEditing] = useState<PastedText | null>(null);
  // A drag carrying files is over the message box.
  const [dropping, setDropping] = useState(false);
  const running = session.state === SessionState.Working || session.state === SessionState.WaitingApproval;
  const queued = session.queued_message;
  // A question waiting on the operator still holds the run: the next message answers it.
  const busy = running || session.state === SessionState.WaitingInput;
  // The files whose chips sit in the message and the crops of the picked elements, and those saved so far.
  const placed = namesInText(text);
  const crops = elements.picks.flatMap((pick) => (pick.crop ? [pick.crop] : []));
  const attached = [...placed, ...crops];
  const files = attachments.saved(attached);
  const uploading = attachments.uploading(attached);
  const typed = text.replace(FILE_TOKEN, '');
  const empty = typed.trim() === '' && files.length === 0 && elements.picks.length === 0;
  // Takes a file out of the message: its file, and its card in the text.
  const clearPasted = (name: string) => {
    attachments.remove([name]);
    setText((now) => now.split(fileToken(name)).join('').replace(/ {2,}/g, ' '));
  };
  const addFiles = (picked: File[]) => editor.current?.insertFiles(attachments.add(picked));
  // An element picked in the Browser panel or a tab's window lands here with its crop attached.
  useIncomingPicks(id, elements.add);
  const questions =
    session.state === SessionState.WaitingInput && lastMessage?.role === 'agent'
      ? trailingQuestions(lastMessage.parts)
      : [];
  const commands: ComposerCommand[] = [
    ...sessionCommands,
    { name: 'skills', description: 'Pick a skill to run', run: () => setText('$') },
    { name: 'files', description: 'Search files to mention', run: () => setText('@') },
  ];
  const composerMenus = useComposerMenus({
    sessionId: id,
    text,
    enabled: session.kind === SessionKind.Repo || session.kind === SessionKind.Anonymous,
    commands,
    setText,
    onSkill: (chosen) => {
      setText(`$${chosen.name} ${text.replace(/^[$/]\S*\s?/, '')}`);
      setPicked({ kind: chosen.kind, name: chosen.name });
      editor.current?.focusEnd();
    },
    focusEnd: () => editor.current?.focusEnd(),
  });
  // The box empties at the click; a message the daemon refused comes back, in front of anything typed since.
  const putBack = (draft: string) => setText((now) => (now.trim() === '' ? draft : `${draft}\n\n${now}`));
  const submit = () => {
    if (empty || queued !== null || uploading) return;
    onSent();
    const draft = text;
    const sentPicks = elements.picks;
    const message = withAttachments(withElementPicks(text, elements.forMessage()), files);
    const sent = () => {
      attachments.remove(attached);
      elements.drop(sentPicks.map((pick) => pick.id));
    };
    setText('');
    if (running) {
      queue.queue.mutate(message, {
        onSuccess: sent,
        onError: () => putBack(draft),
      });
      return;
    }
    // The pick holds only while the text still opens with exactly that name: `$pre` is not the picked `pr`.
    const first = text.split(/\s/, 1)[0];
    const skill = picked && (first === `$${picked.name}` || first === `/${picked.name}`) ? picked : undefined;
    const kept = picked;
    setPicked(null);
    send.mutate(
      { text: message, ...(skill ? { skill } : {}) },
      {
        onSuccess: sent,
        onError: () => {
          putBack(draft);
          setPicked(kept);
        },
      },
    );
  };

  return (
    <>
      <div className="flex flex-col gap-2 px-6 pb-4">
        <ApprovalPrompts sessionId={id} />
        {questions.length > 0 && (
          <QuestionPanel
            // A new question set starts at its first question.
            key={questions.map((question) => question.text).join('\n')}
            questions={questions}
            pending={send.isPending}
            onSend={(answer) => send.mutate(answer)}
          />
        )}
        {session.state === SessionState.Failed && session.last_error && (
          <div
            role="alert"
            className="rounded-lg border border-accent-300 bg-accent-100 px-3 py-2 text-accent-900 text-xs"
          >
            {session.last_error}
          </div>
        )}
        {queued !== null && (
          <QueuedNote
            text={queued}
            held={!busy}
            sending={queue.sendNow.isPending}
            onSendNow={() => queue.sendNow.mutate()}
            onCancel={() => {
              setText((current) => (current.trim() === '' ? queued : `${queued}\n\n${current}`));
              queue.takeBack.mutate();
            }}
          />
        )}
        {reverted && <RevertNote result={reverted} onClose={onRevertedClose} />}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a shortcut; Attach files does the same */}
        <div
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
          }}
          onDrop={(event) => {
            setDropping(false);
            const files = filesIn(event.dataTransfer);
            if (files.length === 0) return;
            event.preventDefault();
            addFiles(files);
          }}
          className={`relative rounded-3xl border bg-card shadow-md transition-[border-color,box-shadow] focus-within:border-accent-400 focus-within:shadow-[0_0_0_3px_var(--color-accent-100)] ${dropping ? 'border-dashed border-accent-400 bg-accent-100' : 'border-divider'}`}
        >
          {composerMenus.menu}
          <PickedChips
            picks={elements.picks}
            thumb={(name) => attachments.find(name)?.preview ?? null}
            onOpen={(name) => {
              const item = attachments.find(name);
              if (item?.file) setViewed({ name, file: item.file });
              else if (item?.saved) setViewed({ name, path: item.saved.path });
            }}
            onRemove={elements.remove}
          />
          <MessageEditor
            ref={editor}
            label="Message"
            value={text}
            placeholder={
              running
                ? 'The agent is working. Type the next message: it sends when the run ends.'
                : 'Ask anything. @ files, $ skills, / commands'
            }
            onChange={(next) => {
              // A chip taken out of the text takes its file with it.
              const gone = placed.filter((name) => !next.includes(fileToken(name)));
              if (gone.length > 0) attachments.remove(gone);
              // The first key is the operator's turn to speak: the agent can start up meanwhile.
              if (text === '' && next !== '') warmSession(id);
              setText(next);
            }}
            find={attachments.find}
            onOpen={(name) => {
              const item = attachments.find(name);
              if (item?.file) setViewed({ name, file: item.file });
              else if (item?.saved) setViewed({ name, path: item.saved.path });
            }}
            onEdit={(name) => {
              const item = attachments.find(name);
              if (item?.file) setEditing({ name, file: item.file });
              else if (item?.saved) setEditing({ name, path: item.saved.path });
            }}
            onPasteFiles={addFiles}
            onSubmit={submit}
            onKey={composerMenus.onKey}
          />
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1 pb-3">
            <AttachButton onFiles={addFiles} />
            <ExtraRepos session={session} repos={repos} />
            {send.isError && (
              <span role="alert" className="text-xs text-accent-700">
                {send.error.message}
              </span>
            )}
            <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <ComposerSettings session={session} />
              <PlayRun sessionId={id} />
              {busy && <StopRun sessionId={id} round />}
              {(!busy || !empty) && (
                <button
                  type="button"
                  aria-label={running ? 'Queue' : 'Send'}
                  title={
                    running
                      ? 'The agent is working. The message waits and sends when the run ends.'
                      : uploading
                        ? 'Waiting for the attached files to upload'
                        : 'Enter sends. Shift+Enter adds a new line.'
                  }
                  disabled={empty || queued !== null || uploading || send.isPending || queue.queue.isPending}
                  onClick={submit}
                  className="flex size-9 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-accent text-white shadow-sm transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-600 disabled:shadow-none"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
      {viewed && <AttachmentViewer viewed={viewed} onClose={() => setViewed(null)} />}
      {editing && (
        <PastedTextEditor
          pasted={editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            // Nothing left to send: the file goes, and its card with it.
            if (next.trim() === '') clearPasted(editing.name);
            else attachments.rewrite(editing.name, next);
            setEditing(null);
          }}
          onClear={() => {
            clearPasted(editing.name);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** The message waiting for the run to end, with a way to take it back. */
function QueuedNote({
  text,
  held,
  sending,
  onSendNow,
  onCancel,
}: {
  text: string;
  /** The operator stopped the run, so the message waits for Send now. */
  held: boolean;
  sending: boolean;
  onSendNow: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs">
      <span className="flex-none font-semibold text-neutral-700">{held ? 'On hold' : 'Queued'}</span>
      <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap text-text">{text}</span>
      <button
        type="button"
        disabled={sending}
        onClick={onSendNow}
        title={
          held
            ? 'You stopped the run, so this did not send. Send it now.'
            : 'Stop the run and send this message now instead of waiting for the run to end.'
        }
        className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-text hover:text-accent-700 disabled:cursor-default disabled:opacity-50"
      >
        Send now
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-700 hover:text-accent-600"
      >
        Take back
      </button>
    </div>
  );
}

/** What editing the last message did to the files: the ones put back, or why none were. */
function RevertNote({ result, onClose }: { result: EditedMessage; onClose: () => void }) {
  const { reverted } = result;
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
        reverted ? 'border-line bg-card text-neutral-700' : 'border-accent-200 bg-accent-100 text-accent-900'
      }`}
    >
      <span className="min-w-0 flex-1">
        {reverted === null
          ? `Files not put back: ${result.revert_error}. The edited message ran on the files as they are.`
          : reverted.files.length === 0
            ? 'No files to put back. The edited message runs again.'
            : `Put back ${reverted.files.length} ${reverted.files.length === 1 ? 'file' : 'files'} (+${reverted.insertions} −${reverted.deletions}): ${reverted.files.join(', ')}`}
      </span>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="cursor-pointer border-0 bg-transparent p-0 text-neutral-600 hover:text-text"
      >
        ×
      </button>
    </div>
  );
}
