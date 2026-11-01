import type { CodeHosts, HostedName } from '../../src/monitor/code-finder';

/** Git hosts in memory: holds the repositories the test names, and records each look. */
export class FakeCodeHosts implements CodeHosts {
  /** `bitbucket/acme/orders-api` style keys of repositories that exist. */
  readonly existing = new Set<string>();
  orgs: string[] = [];
  readonly looked: string[] = [];

  async find(repo: HostedName): Promise<string | null> {
    const key = `${repo.host}/${repo.owner}/${repo.name}`;
    this.looked.push(key);
    return this.existing.has(key) ? `git@${repo.host}.example:${repo.owner}/${repo.name}.git` : null;
  }

  async githubOwners(): Promise<string[]> {
    return this.orgs;
  }
}
