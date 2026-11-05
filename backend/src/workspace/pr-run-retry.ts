import { Inject, Injectable } from '@nestjs/common';
import { AgentReviewStatus, ErrorCode, SessionKind } from '@ops-console/shared';
import { and, eq } from 'drizzle-orm';
import { SessionKinds } from '../agent/session-kinds';
import type { SessionRow } from '../agent/sessions.service';
import { ApiError } from '../common/errors';
import { prAgentReviews, prCommentPasses, prReplyChecks } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { AgentReviewsService } from './agent-reviews.service';
import { CommentPassesService } from './comment-passes.service';
import { ReplyChecksService } from './reply-checks.service';

/**
 * Retry on a pull request's run in the Agent runs page: the job that failed last on that pull request runs again, from
 * its failed step, as Retry does on the pull request itself.
 */
@Injectable()
export class PrRunRetry {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(AgentReviewsService) private readonly reviews: AgentReviewsService,
    @Inject(ReplyChecksService) private readonly checks: ReplyChecksService,
    @Inject(CommentPassesService) private readonly passes: CommentPassesService,
    @Inject(SessionKinds) kinds: SessionKinds,
  ) {
    kinds.registerRetry(SessionKind.PrReview, (session) => this.retry(session));
  }

  private async retry(session: SessionRow): Promise<void> {
    if (session.repoId === null || session.prNumber === null) {
      throw new ApiError(409, ErrorCode.InvalidState, 'This run has no pull request to run again');
    }
    const failed = (table: typeof prAgentReviews | typeof prReplyChecks | typeof prCommentPasses) =>
      this.store.db
        .select({ id: table.id, at: table.finishedAt })
        .from(table)
        .where(
          and(
            eq(table.repoId, session.repoId as string),
            eq(table.prNumber, session.prNumber as number),
            eq(table.status, AgentReviewStatus.Failed),
          ),
        )
        .all();
    const candidates = [
      ...failed(prAgentReviews).map((row) => ({ ...row, run: () => this.reviews.retry(row.id) })),
      ...failed(prReplyChecks).map((row) => ({ ...row, run: () => this.checks.retry(row.id) })),
      ...failed(prCommentPasses).map((row) => ({ ...row, run: () => this.passes.retry(row.id) })),
    ].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    const last = candidates[0];
    if (!last) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        'No failed job to run again on this pull request. Open it and start the review again.',
      );
    }
    await last.run();
  }
}
