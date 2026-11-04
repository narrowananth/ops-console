import {
  AgentReviewStatus,
  type CommentPass,
  CommentPassKind,
  type PassThread,
  ThreadOutcome,
} from '@ops-console/shared';
import { StopRun } from '../agents/stop-run';
import { FoldTitle, useFold } from '../components/ui/fold';
import { Markdown } from '../components/ui/markdown';
import { StatusPill } from '../components/ui/pathway';
import { useRetryCommentPass, useSkipRunningStep } from '../lib/queries';
import { JobFailure, JobPath, PlaybookLink, runState } from '../playbooks/job-steps';
import { threadPlace } from './pr-jobs';

/** The commit's page on the host, from the pull request's own URL; null for a host whose URLs it does not know. */
function commitUrl(prUrl: string, sha: string): string | null {
  const at = [
    [/\/pull\/\d+$/, `/commit/${sha}`],
    [/\/-\/merge_requests\/\d+$/, `/-/commit/${sha}`],
    [/\/pull-requests\/\d+$/, `/commits/${sha}`],
  ] as const;
  for (const [pattern, path] of at) if (pattern.test(prUrl)) return prUrl.replace(pattern, path);
  return null;
}

const OUTCOME_TIP: Record<ThreadOutcome, string> = {
  [ThreadOutcome.Pending]: 'The agent has not answered this thread yet',
  [ThreadOutcome.Done]: 'The agent made the change or found it already made, replied, and resolved the thread',
  [ThreadOutcome.Declined]: 'The agent did not change the code. Its reply says why, and the thread stays open for you.',
  [ThreadOutcome.Fixed]: 'The code at the newest commit does what the thread asked. The agent replied and resolved it.',
  [ThreadOutcome.PartlyFixed]:
    'Part of what the thread asked is done. The reply says what is left; the thread stays open.',
  [ThreadOutcome.NotFixed]:
    'The code does not do what the thread asked yet. The reply says why; the thread stays open.',
};

const OUTCOME_CLASS: Record<ThreadOutcome, string> = {
  [ThreadOutcome.Pending]: 'border-divider text-neutral-700',
  [ThreadOutcome.Done]: 'border-ok/40 bg-ok/10 text-ok',
  [ThreadOutcome.Declined]: 'border-accent-200 bg-accent-100 text-accent-700',
  [ThreadOutcome.Fixed]: 'border-ok/40 bg-ok/10 text-ok',
  [ThreadOutcome.PartlyFixed]: 'border-warn/40 bg-warn/10 text-warn',
  [ThreadOutcome.NotFixed]: 'border-accent-200 bg-accent-100 text-accent-700',
};

/** What resolves a thread: a change made, or a reply the check found true. */
const SETTLED = [ThreadOutcome.Done, ThreadOutcome.Fixed];

/** The card's title for a pass: what the operator pressed. */
export const passTitle = (pass: CommentPass) =>
  pass.kind === CommentPassKind.Check ? 'Check replies' : 'Address comments';

function PassThreadRow({ thread, failed }: { thread: PassThread; failed: boolean }) {
  const unposted = failed && thread.outcome !== ThreadOutcome.Pending && !thread.posted;
  const unresolved = failed && SETTLED.includes(thread.outcome) && thread.posted && !thread.resolved;
  return (
    <li aria-label={threadPlace(thread)} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="min-w-0 truncate font-mono">{threadPlace(thread)}</span>
        <span className="text-neutral-700">{thread.author}</span>
        <span
          title={OUTCOME_TIP[thread.outcome]}
          className={`rounded-full border px-2 py-px text-xs font-semibold ${OUTCOME_CLASS[thread.outcome]}`}
        >
          {thread.outcome.replace('_', ' ')}
        </span>
        {unposted && (
          <span title="The Comment pass stopped before this reply reached the Git host" className="text-accent-700">
            reply not posted
          </span>
        )}
        {unresolved && (
          <span
            title="The reply is posted, but the thread is still open on the Git host. Resolve it from its thread."
            className="text-accent-700"
          >
            not resolved
          </span>
        )}
      </div>
      <div className="text-xs text-neutral-700">{thread.excerpt}</div>
      {thread.reply && <Markdown source={thread.reply} />}
    </li>
  );
}

function PassBody({ pass }: { pass: CommentPass }) {
  const retry = useRetryCommentPass(pass.repo_id, pass.pr_number);
  const skipStep = useSkipRunningStep('comment_pass', pass.id);
  const failed = pass.status === AgentReviewStatus.Failed;
  return (
    <div className="flex flex-col gap-3 px-3 py-2.5 text-[13px]">
      {(pass.status !== AgentReviewStatus.Ready || (pass.playbook && pass.playbook.steps.length > 0)) && (
        <JobPath
          playbook={pass.playbook}
          status={pass.status}
          skip={{ isPending: skipStep.isPending, error: skipStep.error, mutate: () => skipStep.mutate() }}
          answered={pass.threads.every((thread) => thread.outcome !== ThreadOutcome.Pending)}
          reading={{ todo: 'Read the threads', doing: 'Reading the threads' }}
          closing={
            pass.kind === CommentPassKind.Check
              ? { todo: 'Give each thread its verdict', doing: 'Giving each thread its verdict' }
              : { todo: 'Report each thread done or declined', doing: 'Reporting each thread done or declined' }
          }
        />
      )}
      {failed && (
        <JobFailure
          error={pass.error}
          playbook={pass.playbook}
          canRetry={pass.can_retry}
          retry={{
            isPending: retry.isPending,
            error: retry.error,
            mutate: (skip) => retry.mutate({ id: pass.id, skip }),
          }}
        />
      )}
      <ul aria-label="Threads" className="m-0 flex list-none flex-col gap-2.5 p-0">
        {pass.threads.map((thread) => (
          <PassThreadRow key={thread.comment_id} thread={thread} failed={failed} />
        ))}
      </ul>
    </div>
  );
}

function PassHeader({ pass, prUrl, sessionId }: { pass: CommentPass; prUrl: string; sessionId: string | null }) {
  const sha = pass.commit_sha;
  const href = sha && commitUrl(prUrl, sha);
  return (
    <>
      {pass.playbook && <PlaybookLink playbook={pass.playbook} />}
      {sha &&
        (href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title="The commit this Comment pass pushed, on the Git host"
            className="font-mono text-text underline"
          >
            {sha.slice(0, 7)}
          </a>
        ) : (
          <span title="The commit this Comment pass pushed" className="font-mono text-neutral-700">
            {sha.slice(0, 7)}
          </span>
        ))}
      {pass.stale && (
        <span
          title="The pull request has newer commits than this Comment pass"
          className="rounded-full bg-accent-100 px-2 py-px text-xs text-accent-700"
        >
          older commit
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">
        {pass.status === AgentReviewStatus.Running && sessionId && (
          <StopRun sessionId={sessionId} title="Stop the Comment pass; it fails and can retry from its step" />
        )}
        <StatusPill state={runState(pass.status)}>{pass.status}</StatusPill>
      </span>
    </>
  );
}

/** The newest Comment pass open, with the older ones folded under it. */
export function CommentPassCard({
  passes,
  prUrl,
  sessionId,
}: {
  passes: CommentPass[];
  prUrl: string;
  sessionId: string | null;
}) {
  const [newest, ...older] = passes;
  const [folded, toggle] = useFold('comment-pass');
  if (!newest) return null;
  return (
    <section aria-label="Comment pass" className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
      <header
        className={`flex items-center gap-2 bg-surface px-3 py-2 text-xs ${folded ? '' : 'border-b border-divider'}`}
      >
        <FoldTitle label="Comment pass" folded={folded} onToggle={toggle}>
          <strong>{passTitle(newest)}</strong>
        </FoldTitle>
        <PassHeader pass={newest} prUrl={prUrl} sessionId={sessionId} />
      </header>
      <div hidden={folded}>
        <PassBody pass={newest} />
      </div>
      {older.length > 0 && (
        <details hidden={folded} className="border-t border-divider">
          <summary className="cursor-pointer px-3 py-2 text-xs text-neutral-700">
            Older Comment passes · {older.length}
          </summary>
          {older.map((pass) => (
            <article
              key={pass.id}
              aria-label={`Comment pass of ${new Date(pass.created_at).toLocaleString()}`}
              className="border-t border-line"
            >
              <header className="flex items-center gap-2 px-3 pt-2 text-xs">
                <span className="text-neutral-700">
                  {passTitle(pass)} · {new Date(pass.created_at).toLocaleString()}
                </span>
                <PassHeader pass={pass} prUrl={prUrl} sessionId={sessionId} />
              </header>
              <PassBody pass={pass} />
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
