import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  allNetworkDomains,
  BUILT_IN_NETWORK_DOMAINS,
  ErrorCode,
  type NetworkAllowlist,
  networkDomainSchema,
} from '@ops-console/shared';
import { eq, isNull } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { networkDomains, repos } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { remoteHostname } from '../repos/git';
import { coveredBy } from './blocked-hosts';

/**
 * The first `url` of the `origin` remote in a Repo's `.git/config`, or null. A small file read in place, not a `git`
 * process per Repo, so a run starts without waiting on them. A Repo whose `.git` is a file (a worktree) has none here.
 */
function originUrl(repoDir: string): string | null {
  let config = '';
  try {
    config = readFileSync(path.join(repoDir, '.git', 'config'), 'utf8');
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const line of config.split('\n')) {
    const section = /^\s*\[(.*)\]\s*$/.exec(line);
    if (section) inOrigin = /^remote\s+"origin"$/.test(section[1] ?? '');
    else if (inOrigin) {
      const url = /^\s*url\s*=\s*(\S.*?)\s*$/.exec(line)?.[1];
      if (url) return url;
    }
  }
  return null;
}

/** The hosts an agent run's commands may reach (ADR 0006): built-in, the Repos' remotes and the operator's own. */
@Injectable()
export class NetworkAllowlistService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  /** The host of each Repo's `origin`, with the name of the first Repo that has it. A Repo with none adds nothing. */
  private fromRepos(): NetworkAllowlist['from_repos'] {
    const rows = this.store.db
      .select({ name: repos.name, path: repos.path })
      .from(repos)
      .where(isNull(repos.removedAt))
      .orderBy(repos.name)
      .all();
    const found = new Map<string, string>();
    for (const row of rows) {
      const host = remoteHostname(originUrl(row.path));
      // A remote that is no valid domain adds nothing: the run's list never holds `*` or a stray string.
      if (host && networkDomainSchema.safeParse(host).success && !found.has(host)) found.set(host, row.name);
    }
    return [...found].map(([domain, repo]) => ({ domain, repo }));
  }

  private added(): string[] {
    return this.store.db
      .select({ domain: networkDomains.domain })
      .from(networkDomains)
      .orderBy(networkDomains.domain)
      .all()
      .map((row) => row.domain);
  }

  read(): NetworkAllowlist {
    return { built_in: [...BUILT_IN_NETWORK_DOMAINS], from_repos: this.fromRepos(), added: this.added() };
  }

  /** The list a run starts with. A run keeps it; later edits reach the next run. */
  forRun(): string[] {
    return allNetworkDomains(this.read());
  }

  /** True when a run started now could reach `host`. */
  covers(host: string): boolean {
    return coveredBy(allNetworkDomains(this.read()), host);
  }

  /** Saves `domain` unless some group already has it. */
  add(domain: string): { domain: string; created: boolean } {
    if (allNetworkDomains(this.read()).includes(domain)) return { domain, created: false };
    this.store.write((tx) => {
      tx.insert(networkDomains).values({ domain }).run();
    });
    return { domain, created: true };
  }

  remove(domain: string): void {
    const removed = this.store.write((tx) =>
      tx.delete(networkDomains).where(eq(networkDomains.domain, domain)).returning().all(),
    );
    if (removed.length === 0) throw new ApiError(404, ErrorCode.NotFound, 'that domain is not in Added by you');
  }
}
