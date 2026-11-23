import { type DynamicModule, Module } from '@nestjs/common';
import { OPEN_PR_BRANCHES } from '../repos/open-pr-branches';
import { AgentReviewsService } from './agent-reviews.service';
import { AnonymousSessionsService } from './anonymous-sessions.service';
import { CliGitHosts } from './cli-git-hosts';
import { FileMenuController } from './file-menu.controller';
import { FileMenuService } from './file-menu.service';
import { FOLDER_OPENER, type FolderOpener, openFolder } from './folder-opener';
import { GIT_HOSTS, type GitHosts } from './git-host';
import { PrActionsService } from './pr-actions.service';
import { PrHostWrites } from './pr-host-writes';
import { PullRequestOpeningService } from './pull-request-opening.service';
import { PullRequestsService } from './pull-requests.service';
import { RepoJoinService } from './repo-join.service';
import { SessionSpawnService } from './session-spawn.service';
import { PullRequestsController, WorkspaceSessionsController } from './workspace.controller';
import { WorkspaceSessionsService } from './workspace-sessions.service';

/** Workspace: Sessions in a Repo or a folder of their own, their branches, and the pull requests on the Git host. */
@Module({})
export class WorkspaceModule {
  static forRoot(config: { hosts?: GitHosts; opener?: FolderOpener } = {}): DynamicModule {
    return {
      module: WorkspaceModule,
      global: true,
      controllers: [WorkspaceSessionsController, PullRequestsController, FileMenuController],
      providers: [
        { provide: GIT_HOSTS, useValue: config.hosts ?? new CliGitHosts() },
        { provide: FOLDER_OPENER, useValue: config.opener ?? openFolder },
        PullRequestsService,
        AgentReviewsService,
        PrHostWrites,
        PrActionsService,
        WorkspaceSessionsService,
        FileMenuService,
        PullRequestOpeningService,
        AnonymousSessionsService,
        RepoJoinService,
        SessionSpawnService,
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
