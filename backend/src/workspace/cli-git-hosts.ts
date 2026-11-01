import { ErrorCode, GitHost } from '@ops-console/shared';
import { ApiError } from '../common/errors';
import { BitbucketHost } from './bitbucket-host';
import type { GitHostAdapter, GitHosts } from './git-host';
import { GithubHost } from './github-host';
import { GitlabHost } from './gitlab-host';

/** Each host through its own CLI, signed in as the operator (ADR 0005): `gh`, `glab`, `bkt`. */
export class CliGitHosts implements GitHosts {
  private readonly github = new GithubHost();
  private readonly gitlab = new GitlabHost();
  private readonly bitbucket = new BitbucketHost();

  supports(host: GitHost): boolean {
    return host === GitHost.Github || host === GitHost.Gitlab || host === GitHost.Bitbucket;
  }

  for(host: GitHost): GitHostAdapter {
    if (host === GitHost.Github) return this.github;
    if (host === GitHost.Gitlab) return this.gitlab;
    if (host === GitHost.Bitbucket) return this.bitbucket;
    throw new ApiError(409, ErrorCode.InvalidState, 'a local Repo has no pull requests');
  }
}
