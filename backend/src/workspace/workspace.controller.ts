import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import {
  type CommittedSession,
  checkoutSchema,
  commitSessionSchema,
  openFolderSchema,
  openPullRequestSchema,
  type PrAgentReview,
  type PrComment,
  type PrFileContent,
  type PullRequest,
  type PullRequestDetail,
  type PullRequestDraft,
  postCommentSchema,
  prFileQuerySchema,
  pullRequestDraftRequestSchema,
  pullRequestQuerySchema,
  refreshPullRequestsSchema,
  resolveCommentSchema,
  reviewPullRequestSchema,
  type Session,
  type SessionDiff,
  type SessionPullRequest,
  startPrActionSchema,
} from '@ops-console/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { parseInput } from '../common/errors';
import { AgentReviewsService } from './agent-reviews.service';
import { PrActionsService } from './pr-actions.service';
import { PullRequestOpeningService } from './pull-request-opening.service';
import { PullRequestsService } from './pull-requests.service';
import { WorkspaceSessionsService } from './workspace-sessions.service';

const sessionParams = z.object({ id: z.string().min(1) });
const pullParams = z.object({ repo: z.string().min(1), number: z.coerce.number().int().min(1) });
const commentParams = pullParams.extend({ comment_id: z.string().min(1) });

/** Moving a `repo` Session's branch, and what its branch changes. */
@Controller('sessions')
export class WorkspaceSessionsController {
  constructor(
    @Inject(WorkspaceSessionsService) private readonly workspace: WorkspaceSessionsService,
    @Inject(PullRequestOpeningService) private readonly opening: PullRequestOpeningService,
  ) {}

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

  /** Commits every change in the Session's worktree. */
  @Post(':id/commit')
  async commit(@Param() params: unknown, @Body() body: unknown): Promise<{ data: CommittedSession }> {
    const { id } = parseInput(sessionParams, params, 'params');
    const input = parseInput(commitSessionSchema, body ?? {}, 'body');
    return { data: await this.workspace.commit(id, input) };
  }

  /** Pushes the Session's branch to origin, never forced. */
  @Post(':id/push')
  @HttpCode(200)
  async push(@Param() params: unknown): Promise<{ data: { branch: string } }> {
    const { id } = parseInput(sessionParams, params, 'params');
    return { data: await this.opening.pushBranch(id) };
  }

  /** Opens the Session's worktree in the editor or the file manager of the machine the daemon runs on. */
  @Post(':id/open-folder')
  @HttpCode(204)
  async openFolder(@Param() params: unknown, @Body() body: unknown): Promise<void> {
    const { id } = parseInput(sessionParams, params, 'params');
    const input = parseInput(openFolderSchema, body, 'body');
    await this.workspace.openFolder(id, input.target);
  }

  @Get(':id/diff')
  async diff(@Param() params: unknown): Promise<{ data: SessionDiff }> {
    const { id } = parseInput(sessionParams, params, 'params');
    return { data: await this.workspace.diff(id) };
  }

  /** The open pull request of the Session's branch, or whether one can be opened. */
  @Get(':id/pull-request')
  async pullRequest(@Param() params: unknown): Promise<{ data: SessionPullRequest }> {
    const { id } = parseInput(sessionParams, params, 'params');
    return { data: await this.opening.status(id) };
  }

  /** The agent's title and description for the pull request; the operator edits them before it opens. */
  @Post(':id/pull-request-draft')
  @HttpCode(200)
  async draft(@Param() params: unknown, @Body() body: unknown): Promise<{ data: PullRequestDraft }> {
    const { id } = parseInput(sessionParams, params, 'params');
    const input = parseInput(pullRequestDraftRequestSchema, body ?? {}, 'body');
    return { data: await this.opening.draft(id, input.base_branch) };
  }

  /** Pushes the branch and opens the pull request: 201, or 200 when one was already open. */
  @Post(':id/pull-request')
  async open(
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { number: number; url: string } }> {
    const { id } = parseInput(sessionParams, params, 'params');
    const input = parseInput(openPullRequestSchema, body, 'body');
    const { created, ...pull } = await this.opening.openFromUi(id, input);
    res.status(created ? 201 : 200);
    return { data: pull };
  }
}

@Controller()
export class PullRequestsController {
  constructor(
    @Inject(PullRequestsService) private readonly pulls: PullRequestsService,
    @Inject(AgentReviewsService) private readonly reviews: AgentReviewsService,
    @Inject(PrActionsService) private readonly actions: PrActionsService,
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

  @Get('repos/:repo/pull-requests/:number/file')
  async file(@Param() params: unknown, @Query() query: unknown): Promise<{ data: PrFileContent }> {
    const { repo } = parseInput(pullParams, params, 'params');
    const { path, ref } = parseInput(prFileQuerySchema, query, 'query');
    return { data: await this.pulls.file(repo, path, ref) };
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

  @Delete('repos/:repo/pull-requests/:number/comments/:comment_id')
  @HttpCode(204)
  async deleteComment(@Param() params: unknown): Promise<void> {
    const { repo, number, comment_id } = parseInput(commentParams, params, 'params');
    await this.pulls.deleteComment(repo, number, comment_id);
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

  /** Address comments, Check replies and Review with agent: each opens a PR action Session. */
  @Post('repos/:repo/pull-requests/:number/action-sessions')
  @HttpCode(201)
  async startAction(@Param() params: unknown, @Body() body: unknown): Promise<{ data: Session }> {
    const { repo, number } = parseInput(pullParams, params, 'params');
    const input = parseInput(startPrActionSchema, body, 'body');
    return { data: await this.actions.start(repo, number, input) };
  }

  @Get('repos/:repo/pull-requests/:number/agent-reviews')
  async listReviews(@Param() params: unknown): Promise<{ data: PrAgentReview[]; meta: { next_cursor: null } }> {
    const { repo, number } = parseInput(pullParams, params, 'params');
    return { data: await this.reviews.list(repo, number), meta: { next_cursor: null } };
  }
}
