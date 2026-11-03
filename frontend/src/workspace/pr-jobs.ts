import { AgentReviewStatus, type PrComment, type PullRequestDetail } from '@ops-console/shared';

export const BUSY_TITLE = 'The agent is working on this PR';

/** Hover tips on the pull request's agent buttons: what the agent does when the operator presses one. */
export const AGENT_REVIEW_TIP =
  'The agent follows the Review PR Playbook in a Scratch copy at the newest commit, compares the change with the target branch and may run the tests. It posts each finding on its line on the Git host, then one comment with the verdict.';
export const ADDRESS_TIP =
  "Pick open threads, yours or a teammate's. The agent makes the changes they ask for, pushes one commit to this branch, replies in each thread and resolves the ones it did.";
export const CHECK_REPLIES_TIP =
  'The agent checks every open thread that has a reply, in one run, against the code at the newest commit. It replies fixed, partly fixed or not fixed in each, and resolves the fixed ones. It changes no code.';

/** An Agent Review, a Reply check or a Comment pass runs: the pull request's Session takes one at a time. */
export const agentBusy = (pr: PullRequestDetail) =>
  pr.latest_agent_review?.status === AgentReviewStatus.Running ||
  pr.reply_checks.some((check) => check.status === AgentReviewStatus.Running) ||
  pr.comment_passes.some((pass) => pass.status === AgentReviewStatus.Running);

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
