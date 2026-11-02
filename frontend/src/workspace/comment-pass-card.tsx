import { AgentReviewStatus, type CommentPass, type PassThread, ThreadOutcome } from '@ops-console/shared';
import { Markdown } from '../components/ui/markdown';
import { StatusPill } from '../components/ui/pathway';
import { useRetryCommentPass } from '../lib/queries';
import { JobFailure, JobPath, PlaybookLink, runState } from '../playbooks/job-steps';

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

const OUTCOME_CLASS: Record<ThreadOutcome, string> = {
  [ThreadOutcome.Pending]: 'border-divider text-neutral-700',
  [ThreadOutcome.Done]: 'border-ok/40 bg-ok/10 text-ok',
  [ThreadOutcome.Declined]: 'border-accent-200 bg-accent-100 text-accent-700',
};

function PassThreadRow({ thread, failed }: { thread: PassThread; failed: boolean }) {
  const unposted = failed && thread.outcome !== ThreadOutcome.Pending && !thread.posted;
  const unresolved = failed && thread.outcome === ThreadOutcome.Done && thread.posted && !thread.resolved;
  return (
    <li aria-label={`${thread.file_path}:${thread.line}`} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="min-w-0 truncate font-mono">
          {thread.file_path}:{thread.line}
        </span>
        <span className="text-neutral-700">{thread.author}</span>
        <span className={`rounded-full border px-2 py-px text-[10px] font-semibold ${OUTCOME_CLASS[thread.outcome]}`}>
          {thread.outcome}
        </span>
        {unposted && <span className="text-accent-700">reply not posted</span>}
        {unresolved && <span className="text-accent-700">not resolved</span>}
      </div>
      <div className="text-xs text-neutral-700">{thread.excerpt}</div>
      {thread.reply && <Markdown source={thread.reply} />}
    </li>
  );
}

function PassBody({ pass }: { pass: CommentPass }) {
  const retry = useRetryCommentPass(pass.repo_id, pass.pr_number);
  const failed = pass.status === AgentReviewStatus.Failed;
  return (
    <div className="flex flex-col gap-3 px-3 py-2.5 text-[13px]">
      {(pass.status !== AgentReviewStatus.Ready || (pass.playbook && pass.playbook.steps.length > 0)) && (
        <JobPath
          playbook={pass.playbook}
          status={pass.status}
          reading={{ todo: 'Read the threads', doing: 'Reading the threads' }}
          closing={{
            todo: 'Report each thread done or declined',
            doing: 'Reporting each thread done or declined',
          }}
        />
      )}
      {failed && (
        <JobFailure
          error={pass.error}
          playbook={pass.playbook}
          canRetry={pass.can_retry}
          retry={{ isPending: retry.isPending, error: retry.error, mutate: () => retry.mutate(pass.id) }}
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

function PassHeader({ pass, prUrl }: { pass: CommentPass; prUrl: string }) {
  const sha = pass.commit_sha;
  const href = sha && commitUrl(prUrl, sha);
  return (
    <>
      {pass.playbook && <PlaybookLink playbook={pass.playbook} />}
      {sha &&
        (href ? (
          <a href={href} target="_blank" rel="noreferrer" className="font-mono text-text underline">
            {sha.slice(0, 7)}
          </a>
        ) : (
          <span className="font-mono text-neutral-700">{sha.slice(0, 7)}</span>
        ))}
      {pass.stale && (
        <span className="rounded-full bg-accent-100 px-2 py-px text-[10px] text-accent-700">older commit</span>
      )}
      <span className="ml-auto">
        <StatusPill state={runState(pass.status)}>{pass.status}</StatusPill>
      </span>
    </>
  );
}

/** The newest Comment pass open, with the older ones folded under it. */
export function CommentPassCard({ passes, prUrl }: { passes: CommentPass[]; prUrl: string }) {
  const [newest, ...older] = passes;
  if (!newest) return null;
  return (
    <section aria-label="Comment pass" className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
      <header className="flex items-center gap-2 border-b border-divider bg-surface px-3 py-2 text-xs">
        <strong>Comment pass</strong>
        <PassHeader pass={newest} prUrl={prUrl} />
      </header>
      <PassBody pass={newest} />
      {older.length > 0 && (
        <details className="border-t border-divider">
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
                <span className="text-neutral-700">{new Date(pass.created_at).toLocaleString()}</span>
                <PassHeader pass={pass} prUrl={prUrl} />
              </header>
              <PassBody pass={pass} />
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
