import { AgentReviewStatus, type PrComment, type PullRequestDetail } from '@ops-console/shared';

export const BUSY_TITLE = 'The agent is working on this PR';

/** An Agent Review, a Reply check or a Comment pass runs: the pull request's Session takes one at a time. */
export const agentBusy = (pr: PullRequestDetail) =>
  pr.latest_agent_review?.status === AgentReviewStatus.Running ||
  pr.reply_checks.some((check) => check.status === AgentReviewStatus.Running) ||
  pr.comment_passes.some((pass) => pass.status === AgentReviewStatus.Running);

/** The unresolved threads on a line, by their first comment: what Address comments can work on. */
export const openLineThreads = (pr: PullRequestDetail) =>
  pr.comments.filter(
    (comment) => comment.parent_id === null && comment.file_path !== null && comment.line !== null && !comment.resolved,
  );

/** The thread's newest comment. */
export const lastOf = (root: PrComment, replies: PrComment[]) =>
  replies.reduce((last, comment) => (comment.created_at > last.created_at ? comment : last), root);

/** The first line of a comment, for a list that names it. */
export const firstLine = (body: string) => body.trim().split('\n')[0] ?? '';
