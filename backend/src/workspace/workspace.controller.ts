import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  checkoutSchema,
  type PrAgentReview,
  type PrComment,
  type PullRequest,
  type PullRequestDetail,
  postCommentSchema,
  pullRequestQuerySchema,
  refreshPullRequestsSchema,
  resolveCommentSchema,
  reviewPullRequestSchema,
  type Session,
} from '@ops-console/shared';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { AgentReviewsService } from './agent-reviews.service';
import { PullRequestsService } from './pull-requests.service';
import { WorkspaceSessionsService } from './workspace-sessions.service';

const sessionParams = z.object({ id: z.string().min(1) });
const pullParams = z.object({ repo: z.string().min(1), number: z.coerce.number().int().min(1) });
const commentParams = pullParams.extend({ comment_id: z.string().min(1) });

/** Moving a `repo` Session's branch. */
@Controller('sessions')
export class WorkspaceSessionsController {
  constructor(@Inject(WorkspaceSessionsService) private readonly workspace: WorkspaceSessionsService) {}

  @Post(':id/checkout')
  @HttpCode(200)
  async checkout(
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<{ data: { session: Session; stashed: boolean } }> {
    const { id } = parseInput(sessionParams, params, 'params');
    const input = parseInput(checkoutSchema, body, 'body');
    return { data: await this.workspace.checkout(id, input.branch, input.create) };
  }
}

@Controller()
export class PullRequestsController {
  constructor(
    @Inject(PullRequestsService) private readonly pulls: PullRequestsService,
    @Inject(AgentReviewsService) private readonly reviews: AgentReviewsService,
  ) {}

  @Get('pull-requests')
  list(@Query() query: unknown) {
    return this.pulls.list(parseInput(pullRequestQuerySchema, query, 'query'));
  }

  @Post('pull-requests/refresh')
  @HttpCode(202)
  refresh(@Body() body: unknown): { data: { accepted: true } } {
    this.pulls.refresh(parseInput(refreshPullRequestsSchema, body ?? {}, 'body').repo_id);
    return { data: { accepted: true } };
  }

  @Get('repos/:repo/pull-requests/:number')
  async get(@Param() params: unknown): Promise<{ data: PullRequestDetail }> {
    const { repo, number } = parseInput(pullParams, params, 'params');
    return { data: await this.pulls.get(repo, number) };
  }

  @Post('repos/:repo/pull-requests/:number/comments')
  async comment(@Param() params: unknown, @Body() body: unknown): Promise<{ data: PrComment }> {
    const { repo, number } = parseInput(pullParams, params, 'params');
    const posted = await this.pulls.comment(repo, number, parseInput(postCommentSchema, body, 'body'));
    this.reviews.afterReply(repo, number, posted);
    return { data: posted };
  }

  @Patch('repos/:repo/pull-requests/:number/comments/:comment_id')
  async resolve(@Param() params: unknown, @Body() body: unknown): Promise<{ data: PrComment }> {
    const { repo, number, comment_id } = parseInput(commentParams, params, 'params');
    const { resolved } = parseInput(resolveCommentSchema, body, 'body');
    return { data: await this.pulls.resolve(repo, number, comment_id, resolved) };
  }

  @Post('repos/:repo/pull-requests/:number/reviews')
  @HttpCode(200)
  async review(@Param() params: unknown, @Body() body: unknown): Promise<{ data: PullRequest }> {
    const { repo, number } = parseInput(pullParams, params, 'params');
    const input = parseInput(reviewPullRequestSchema, body, 'body');
    return { data: await this.pulls.review(repo, number, input.event, input.body) };
  }

  @Post('repos/:repo/pull-requests/:number/merge')
  @HttpCode(200)
  async merge(@Param() params: unknown): Promise<{ data: PullRequest }> {
    const { repo, number } = parseInput(pullParams, params, 'params');
    return { data: await this.pulls.merge(repo, number) };
  }

  @Post('repos/:repo/pull-requests/:number/agent-reviews')
  @HttpCode(202)
  async startReview(@Param() params: unknown): Promise<{ data: PrAgentReview }> {
    const { repo, number } = parseInput(pullParams, params, 'params');
    return { data: await this.reviews.start(repo, number) };
  }

  @Get('repos/:repo/pull-requests/:number/agent-reviews')
  async listReviews(@Param() params: unknown): Promise<{ data: PrAgentReview[]; meta: { next_cursor: null } }> {
    const { repo, number } = parseInput(pullParams, params, 'params');
    return { data: await this.reviews.list(repo, number), meta: { next_cursor: null } };
  }
}
