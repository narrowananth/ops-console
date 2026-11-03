import type { Part } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '../components/ui/button';
import { Markdown } from '../components/ui/markdown';

export type Question = Extract<Part, { kind: 'question' }>;

type Answer = { picked: string[]; custom: string };

const NONE: Answer = { picked: [], custom: '' };

/** The answer to one question: what the operator typed wins over the options they ticked. */
const answerOf = (answer: Answer): string => answer.custom.trim() || answer.picked.join(', ');

/** The message that answers every question. One question: just the answer. */
export function answersText(questions: Question[], answers: Answer[]): string {
  const [only] = questions;
  if (questions.length === 1 && only) return answerOf(answers[0] ?? NONE);
  return questions.map((question, at) => `${question.text}\n→ ${answerOf(answers[at] ?? NONE)}`).join('\n\n');
}

/** The questions trailing a message, in order. */
export function trailingQuestions(parts: Part[]): Question[] {
  const found: Question[] = [];
  for (const part of parts.toReversed()) {
    if (part.kind !== 'question') break;
    found.unshift(part);
  }
  return found;
}

/**
 * The agent's open questions, one at a time above the message box: tick an option or type your own, 1-9 picks an
 * option, and the last question sends all the answers as one message.
 */
export function QuestionPanel({
  questions,
  pending,
  onSend,
}: {
  questions: Question[];
  pending: boolean;
  onSend: (text: string) => void;
}) {
  const [at, setAt] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(() => NONE));
  const advance = useRef<number | null>(null);
  const question = questions[at];
  const answer = answers[at] ?? NONE;
  const last = at === questions.length - 1;
  const answered = answerOf(answer) !== '';
  const everyAnswered = questions.every((_, index) => answerOf(answers[index] ?? NONE) !== '');

  useEffect(() => () => window.clearTimeout(advance.current ?? undefined), []);

  const change = (next: Answer) => setAnswers((current) => current.map((old, index) => (index === at ? next : old)));
  const pick = (label: string) => {
    if (!question || pending) return;
    if (question.multi_select) {
      const picked = answer.picked.includes(label)
        ? answer.picked.filter((one) => one !== label)
        : [...answer.picked, label];
      change({ picked, custom: '' });
      return;
    }
    change({ picked: [label], custom: '' });
    // A single choice moves on by itself, except on the last question, which waits for Send.
    window.clearTimeout(advance.current ?? undefined);
    if (!last) advance.current = window.setTimeout(() => setAt((current) => current + 1), 200);
  };
  const send = () => {
    if (!everyAnswered || pending) return;
    onSend(answersText(questions, answers));
  };

  // 1-9 picks the option of that number, unless the operator is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || pending || !question) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const option = question.options[Number.parseInt(event.key, 10) - 1];
      if (!option) return;
      event.preventDefault();
      pick(option.label);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (!question) return null;
  return (
    <section
      aria-label="The agent asks"
      className="flex flex-col gap-2.5 rounded-xl border border-accent-300 bg-accent-100/60 px-4 py-3 shadow-sm"
    >
      <div className="flex items-center gap-2">
        {question.header && (
          <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase">
            {question.header}
          </span>
        )}
        <span className="text-[10px] tracking-[0.08em] text-neutral-700 uppercase">The agent asks</span>
        {questions.length > 1 && (
          <span className="ml-auto text-xs text-neutral-700">
            {at + 1} / {questions.length}
          </span>
        )}
      </div>
      <div className="text-sm font-bold">
        <Markdown source={question.text} />
      </div>
      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="sr-only">{question.multi_select ? 'Pick one or more' : 'Pick one'}</legend>
        {question.options.map((option, index) => {
          const selected = answer.custom.trim() === '' && answer.picked.includes(option.label);
          return (
            <label
              key={option.label}
              className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-1.5 transition-colors ${
                selected ? 'border-accent-400 bg-card' : 'border-transparent hover:bg-card/70'
              }`}
            >
              <input
                type={question.multi_select ? 'checkbox' : 'radio'}
                name={`question-${at}`}
                checked={selected}
                disabled={pending}
                onChange={() => pick(option.label)}
                className="mt-1 accent-accent"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold">{option.label}</span>
                {option.description && <span className="text-xs text-neutral-700">{option.description}</span>}
              </span>
              {index < 9 && <kbd className="font-mono text-[11px] text-neutral-600">{index + 1}</kbd>}
            </label>
          );
        })}
        <input
          type="text"
          aria-label="Or type your own answer"
          placeholder="Or type your own answer"
          value={answer.custom}
          disabled={pending}
          onChange={(event) => change({ picked: [], custom: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (last) send();
            else if (answered) setAt(at + 1);
          }}
          className="mt-1 rounded-md border border-divider bg-card px-2.5 py-1.5 text-sm outline-none focus:border-accent-400"
        />
      </fieldset>
      <div className="flex items-center gap-2">
        {at > 0 && (
          <Button className="px-3 py-1 text-xs" disabled={pending} onClick={() => setAt(at - 1)}>
            Back
          </Button>
        )}
        <span className="flex-1" />
        {last ? (
          <Button
            variant="primary"
            className="px-3 py-1 text-xs"
            disabled={!everyAnswered || pending}
            title={everyAnswered ? 'Send your answers to the agent' : 'Answer every question first'}
            onClick={send}
          >
            {pending && <Spinner />}
            {questions.length > 1 ? 'Send answers' : 'Send answer'}
          </Button>
        ) : (
          <Button variant="primary" className="px-3 py-1 text-xs" disabled={!answered} onClick={() => setAt(at + 1)}>
            Next
          </Button>
        )}
      </div>
    </section>
  );
}
