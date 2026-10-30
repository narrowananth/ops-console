import { ErrorCode, GitHost } from '@ops-console/shared';
import { ApiError } from '../common/errors';
import type { GitHostAdapter, GitHosts } from './git-host';
import { GithubHost } from './github-host';

/** GitLab and Bitbucket pull requests wait for their adapters; the interface is the same. */
class UnsupportedHost implements GitHostAdapter {
  constructor(private readonly name: string) {}

  private fail(): never {
    throw new ApiError(502, ErrorCode.UpstreamFailed, `${this.name} pull requests are not supported yet`);
  }

  list = async () => this.fail();
  get = async () => this.fail();
  postComment = async () => this.fail();
  setResolved = async () => this.fail();
  review = async () => this.fail();
  merge = async () => this.fail();
}

export class CliGitHosts implements GitHosts {
  private readonly github = new GithubHost();
  private readonly gitlab = new UnsupportedHost('GitLab');
  private readonly bitbucket = new UnsupportedHost('Bitbucket');

  for(host: GitHost): GitHostAdapter {
    if (host === GitHost.Github) return this.github;
    if (host === GitHost.Gitlab) return this.gitlab;
    if (host === GitHost.Bitbucket) return this.bitbucket;
    throw new ApiError(409, ErrorCode.InvalidState, 'a local Repo has no pull requests');
  }
}
