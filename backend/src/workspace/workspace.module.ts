import { type DynamicModule, Module } from '@nestjs/common';
import { OPEN_PR_BRANCHES } from '../repos/open-pr-branches';
import { AgentReviewsService } from './agent-reviews.service';
import { CliGitHosts } from './cli-git-hosts';
import { GIT_HOSTS, type GitHosts } from './git-host';
import { PullRequestsService } from './pull-requests.service';
import { PullRequestsController, WorkspaceSessionsController } from './workspace.controller';
import { WorkspaceSessionsService } from './workspace-sessions.service';

/** Workspace: Sessions in a Repo, their branches, and the pull requests on the Git host. */
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
        WorkspaceSessionsService,
        { provide: OPEN_PR_BRANCHES, useExisting: PullRequestsService },
      ],
      exports: [PullRequestsService, WorkspaceSessionsService, OPEN_PR_BRANCHES],
    };
  }
}
