import { PrAction, PrActionState, type PrComment, type PullRequestDetail } from '@ops-console/shared';

export const BUSY_TITLE = 'The Session is working on this pull request';

export const LINKED_TITLE = 'A Session is already linked to this pull request';

/** Hover tips on the pull request's agent buttons: what opens when the operator presses one. */
export const AGENT_REVIEW_TIP =
  'Starts a Round in this pull request’s Session at the newest commit. The agent follows the Review PR Playbook, compares the change with the target branch and may run the tests. The console posts each finding on its line on the Git host, then one comment with the verdict.';
export const ADDRESS_TIP =
  "Pick open threads, yours or a teammate's. Starts a Round in this pull request's Session where the agent makes the changes they ask for. The console pushes one commit to this branch, replies in each thread and resolves the ones the agent did.";
export const CHECK_REPLIES_TIP =
  'Starts a Round in this pull request’s Session where the agent checks every open thread that has a reply against the code at the newest commit. The console posts fixed, partly fixed or not fixed in each, and resolves the fixed ones. Nothing is committed.';

/** How each PR action reads on a button and in the Sessions rail. */
export const ACTION_LABEL: Record<PrAction, string> = {
  [PrAction.AddressComments]: 'Address comments',
  [PrAction.CheckReplies]: 'Check replies',
  [PrAction.Review]: 'Agent Review',
};

export const ACTION_STATE_LABEL: Record<PrActionState, string> = {
  [PrActionState.Working]: 'working',
  [PrActionState.NotSubmitted]: 'not submitted',
  [PrActionState.Submitted]: 'submitted',
};

/** The pull request's PR Session: the newest Session a button opened. */
const prSession = (pr: PullRequestDetail) => pr.action_sessions[0] ?? null;

/** The PR Session's turn is running: all three buttons wait. */
export const sessionWorking = (pr: PullRequestDetail) => prSession(pr)?.state === PrActionState.Working;

/** The PR Session is working on a Round of this action. */
export const roundWorking = (pr: PullRequestDetail, action: PrAction) =>
  sessionWorking(pr) && prSession(pr)?.action === action;

/** The unresolved threads, by their first comment, on a line, a file or the pull request: what Address comments can work on. */
export const openThreads = (pr: PullRequestDetail) =>
  pr.comments.filter((comment) => comment.parent_id === null && !comment.resolved);

/** Open threads with a reply whose newest comment is not the agent's: what Check replies checks. */
export const repliedThreads = (pr: PullRequestDetail) =>
  openThreads(pr).filter((root) => {
    const replies = pr.comments.filter((comment) => comment.parent_id === root.id);
    return replies.length > 0 && !lastOf(root, replies).by_agent;
  });

/** Where a thread sits: `file:line`, a file, or "General comment" for one on the pull request. */
export const threadPlace = (thread: { file_path: string | null; line: number | null }) =>
  thread.file_path ? `${thread.file_path}${thread.line !== null ? `:${thread.line}` : ''}` : 'General comment';

/** The thread's newest comment. */
export const lastOf = (root: PrComment, replies: PrComment[]) =>
  replies.reduce((last, comment) => (comment.created_at > last.created_at ? comment : last), root);

/** The first line of a comment, for a list that names it. */
export const firstLine = (body: string) => body.trim().split('\n')[0] ?? '';

/** The commit's page on the host, from the pull request's own URL; null for a host whose URLs it does not know. */
export function commitUrl(prUrl: string, sha: string): string | null {
  const at: [RegExp, string][] = [
    [/\/pull\/\d+$/, `/commit/${sha}`],
    [/\/-\/merge_requests\/\d+$/, `/-/commit/${sha}`],
    [/\/pull-requests\/\d+$/, `/commits/${sha}`],
  ];
  for (const [pattern, path] of at) if (pattern.test(prUrl)) return prUrl.replace(pattern, path);
  return null;
}
