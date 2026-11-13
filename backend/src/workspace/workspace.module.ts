import { type DynamicModule, Module } from '@nestjs/common';
import { OPEN_PR_BRANCHES } from '../repos/open-pr-branches';
import { AgentReviewsService } from './agent-reviews.service';
import { AnonymousSessionsService } from './anonymous-sessions.service';
import { CliGitHosts } from './cli-git-hosts';
import { CommentPassesService } from './comment-passes.service';
import { GIT_HOSTS, type GitHosts } from './git-host';
import { PrJobs } from './pr-jobs';
import { PrRunRetry } from './pr-run-retry';
import { PullRequestOpeningService } from './pull-request-opening.service';
import { PullRequestsService } from './pull-requests.service';
import { ReplyChecksService } from './reply-checks.service';
import { RepoJoinService } from './repo-join.service';
import { SessionSpawnService } from './session-spawn.service';
import { PullRequestsController, WorkspaceSessionsController } from './workspace.controller';
import { WorkspaceSessionsService } from './workspace-sessions.service';

/** Workspace: Sessions in a Repo or a folder of their own, their branches, and the pull requests on the Git host. */
@Module({})
export class WorkspaceModule {
  static forRoot(config: { hosts?: GitHosts } = {}): DynamicModule {
    return {
      module: WorkspaceModule,
      global: true,
      controllers: [WorkspaceSessionsController, PullRequestsController],
      providers: [
        { provide: GIT_HOSTS, useValue: config.hosts ?? new CliGitHosts() },
        PullRequestsService,
        AgentReviewsService,
        PrJobs,
        ReplyChecksService,
        CommentPassesService,
        WorkspaceSessionsService,
        PullRequestOpeningService,
        AnonymousSessionsService,
        RepoJoinService,
        SessionSpawnService,
        PrRunRetry,
        { provide: OPEN_PR_BRANCHES, useExisting: PullRequestsService },
      ],
      exports: [
        PullRequestsService,
        PullRequestOpeningService,
        WorkspaceSessionsService,
        AnonymousSessionsService,
        OPEN_PR_BRANCHES,
      ],
    };
  }
}
