import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConnectorId, GitHost, HealthStatus } from '@ops-console/shared';
import { eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { mapLimit } from '../common/map-limit';
import { asBackground, hostCliPool } from '../common/spawn-pool';
import { connectors, repos, routes, services } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git } from '../repos/git';
import { ReposService } from '../repos/repos.service';
import { parseJson, type ServiceRow } from './mappers';

const run = promisify(execFile);

export const CODE_HOSTS = Symbol('CODE_HOSTS');

/** A repository on a Git host, named by its owner and name. */
export type HostedName = { host: GitHost.Github | GitHost.Gitlab | GitHost.Bitbucket; owner: string; name: string };

/** The Git hosts as the operator's own tools reach them. Tests replace it with a fake. */
export interface CodeHosts {
  /** The Git URL of the repository when the operator can read it; null when it is missing or out of reach. */
  find(repo: HostedName): Promise<string | null>;
  /** The GitHub login and the organizations it belongs to. */
  githubOwners(): Promise<string[]>;
}

const HOST_NAME: Record<HostedName['host'], string> = {
  [GitHost.Github]: 'github.com',
  [GitHost.Gitlab]: 'gitlab.com',
  [GitHost.Bitbucket]: 'bitbucket.org',
};

/** Services looked for at once. */
const LOOKS_AT_ONCE = 2;
/** A Service whose code was not found is looked for again after this. */
const LOOK_AGAIN_MS = 7 * 86_400_000;
/** A workspace's repository list is kept this long, so a Scan's Services share one read. */
const NAMES_TTL_MS = 5 * 60_000;
/** Pages of a workspace's repository list read: a bound on a runaway `next`. */
const NAME_PAGES = 30;

const namesPage = z.object({ values: z.array(z.object({ slug: z.string() })), next: z.string().nullish() });

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * `gh` for GitHub; for Bitbucket one list of the workspace's repositories through `bkt`, and `git ls-remote` over SSH,
 * with no prompt, when that list cannot be read and for GitLab.
 */
export class CliCodeHosts implements CodeHosts {
  private readonly lists = new Map<string, { at: number; slugs: Promise<Set<string> | null> }>();

  /** The repository slugs of a Bitbucket workspace; null when `bkt` cannot list them. */
  private bitbucketSlugs(workspace: string): Promise<Set<string> | null> {
    const key = workspace.toLowerCase();
    const kept = this.lists.get(key);
    if (kept && Date.now() - kept.at < NAMES_TTL_MS) return kept.slugs;
    const slugs = (async () => {
      try {
        const found = new Set<string>();
        for (let at = 1; at <= NAME_PAGES; at++) {
          const { stdout } = await hostCliPool.run(() =>
            run(
              'bkt',
              [
                'api',
                `/repositories/${workspace}`,
                '-P',
                'pagelen=100',
                '-P',
                `page=${at}`,
                '-P',
                'fields=next,values.slug',
              ],
              { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
            ),
          );
          const read = namesPage.parse(JSON.parse(stdout));
          for (const value of read.values) found.add(value.slug.toLowerCase());
          if (!read.next) break;
        }
        return found;
      } catch {
        return null;
      }
    })();
    this.lists.set(key, { at: Date.now(), slugs });
    return slugs;
  }

  async find(repo: HostedName): Promise<string | null> {
    try {
      if (repo.host === GitHost.Bitbucket) {
        const slugs = await this.bitbucketSlugs(repo.owner);
        if (slugs !== null) {
          const slug = [repo.name.toLowerCase(), slugOf(repo.name)].find((candidate) => slugs.has(candidate));
          return slug ? `git@${HOST_NAME[repo.host]}:${repo.owner}/${slug}.git` : null;
        }
      }
      if (repo.host === GitHost.Github) {
        await run('gh', ['repo', 'view', `${repo.owner}/${repo.name}`, '--json', 'name'], { timeout: 15_000 });
        return `github.com/${repo.owner}/${repo.name}`;
      }
      const url = `git@${HOST_NAME[repo.host]}:${repo.owner}/${repo.name}.git`;
      const { stdout } = await run('git', ['ls-remote', '--heads', url], {
        timeout: 15_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=8',
        },
      });
      return stdout.trim() === '' ? null : url;
    } catch {
      return null;
    }
  }

  async githubOwners(): Promise<string[]> {
    try {
      const { stdout } = await run('gh', ['api', 'user/orgs', '--jq', '.[].login'], { timeout: 15_000 });
      return stdout.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

export type FindResult = { found: 'repo' | 'url' | null; tried: string[] };

/** Routes of a Service searched for in the imported Repos. */
const ROUTES_SEARCHED = 8;

/**
 * The text of a Route's path to search a codebase for: the path with no query, cut before its first dynamic segment
 * (`:id`, `{id}`, a number or a uuid). Null for a path too bare to say anything, such as `/` or `/api`, and for a probe
 * of a file no Service serves (`/.env`, `/favicon.ico`).
 */
export function searchablePath(routePath: string): string | null {
  const segments = (routePath.split('?')[0] ?? '').split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.')) || /\.[a-z0-9]{1,5}$/i.test(segments.at(-1) ?? ''))
    return null;
  const fixed: string[] = [];
  for (const segment of segments) {
    if (/^[:{[*]|^\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment)) break;
    fixed.push(segment);
  }
  const text = `/${fixed.join('/')}`;
  const long = fixed.filter((segment) => segment.length >= 3);
  return long.length > 0 && text.length >= 5 ? text : null;
}

const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Finds a Service's code with no help from the operator, first match wins: an imported Repo of the same name, a git
 * folder of that name next to an imported Repo (imported then), then the imported Repo whose source holds the
 * Service's Route paths, then a repository of that name on a connected Git host, under the Bitbucket workspace, the GitHub login and its organizations, or an owner of an imported Repo.
 */
@Injectable()
export class CodeFinder {
  private readonly logger = new Logger('monitor');
  private readonly running = new Map<string, Promise<FindResult>>();
  private draining: Promise<void> | null = null;
  private again = false;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
    @Inject(ReposService) private readonly repos: ReposService,
    @Inject(CODE_HOSTS) private readonly hosts: CodeHosts,
  ) {}

  /**
   * After a Scan: looks for each Service with no code that was not looked for in the last week, two at a time, in the
   * background. Each look is kept in `services.code_looked_at`, so a restart does not look again.
   */
  lookForUnlinked(): void {
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = asBackground(() => this.drain()).finally(() => {
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    do {
      this.again = false;
      const stale = new Date(Date.now() - LOOK_AGAIN_MS).toISOString();
      const unlinked = this.store.db
        .select()
        .from(services)
        .all()
        .filter(
          (row) =>
            row.repoId === null && row.repoUrl === null && (row.codeLookedAt === null || row.codeLookedAt < stale),
        );
      await mapLimit(unlinked, LOOKS_AT_ONCE, (row) =>
        this.find(row.id).catch((error) =>
          this.logger.warn(`code for ${row.name} not looked for: ${error instanceof Error ? error.message : error}`),
        ),
      );
    } while (this.again);
  }

  /** One look at a time per Service; a second caller shares it. */
  find(serviceId: string): Promise<FindResult> {
    const pending = this.running.get(serviceId);
    if (pending) return pending;
    const look = this.look(serviceId).finally(() => this.running.delete(serviceId));
    this.running.set(serviceId, look);
    return look;
  }

  private async look(serviceId: string): Promise<FindResult> {
    const service = this.store.db.select().from(services).where(eq(services.id, serviceId)).get();
    if (!service) return { found: null, tried: [] };
    if (service.repoId) return { found: 'repo', tried: [] };
    // A Git URL alone is a clone; the operator works in a local Repo, so a local one is still looked for.
    const hasUrl = service.repoUrl !== null;
    const tried: string[] = [];
    const imported = this.store.db.select().from(repos).where(isNull(repos.removedAt)).all();

    tried.push(`an imported Repo named ${service.name}`);
    const same = imported.find(
      (repo) =>
        plain(repo.name) === plain(service.name) ||
        plain(repo.remoteSlug?.split('/').at(-1) ?? '') === plain(service.name),
    );
    if (same) return this.link(service, { repoId: same.id }, 'repo', tried);

    for (const parent of new Set(imported.map((repo) => path.dirname(repo.path)))) {
      const folder = path.join(parent, service.name);
      tried.push(`a git folder ${folder}`);
      if ((await this.git.topFolder(folder)) !== (await realpath(folder).catch(() => null))) continue;
      const repo = await this.repos.import(folder).catch(() => null);
      if (repo) return this.link(service, { repoId: repo.id }, 'repo', tried);
    }

    const served = await this.servingRepo(service, imported, tried);
    if (served) return this.link(service, { repoId: served.id }, 'repo', tried);
    if (hasUrl) return { found: 'url', tried: [] };

    for (const candidate of await this.owners(imported)) {
      const repo = { ...candidate, name: service.name };
      tried.push(`${HOST_NAME[repo.host]}/${repo.owner}/${repo.name}`);
      const url = await this.hosts.find(repo);
      if (url) return this.link(service, { repoUrl: url }, 'url', tried);
    }
    this.store.write((tx) =>
      tx.update(services).set({ codeLookedAt: new Date().toISOString() }).where(eq(services.id, service.id)).run(),
    );
    return { found: null, tried };
  }

  /**
   * The imported Repo whose code serves the Service's Routes: for up to eight Routes, the Repos whose source holds
   * the Route's path. The Repo holding the most Routes wins; a tie is left to the operator unless one of the tied
   * Repos carries the Service's name.
   */
  private async servingRepo(
    service: ServiceRow,
    imported: (typeof repos.$inferSelect)[],
    tried: string[],
  ): Promise<typeof repos.$inferSelect | null> {
    const paths = [
      ...new Set(
        this.store.db
          .select()
          .from(routes)
          .where(eq(routes.serviceId, service.id))
          .all()
          .filter((route) => !route.ignored)
          .map((route) => searchablePath(route.path))
          .filter((found): found is string => found !== null),
      ),
    ].slice(0, ROUTES_SEARCHED);
    if (paths.length === 0 || imported.length === 0) return null;
    tried.push(`the Routes of ${service.name} in the imported Repos (${paths.join(', ')})`);
    const scores = await mapLimit(imported, 4, async (repo) => {
      const hits = await Promise.all(paths.map((one) => this.git.filesHolding(repo.path, one)));
      return { repo, score: hits.filter((files) => files.length > 0).length };
    });
    const ranked = scores.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
    const top = ranked[0];
    if (!top) return null;
    const tied = ranked.filter((entry) => entry.score === top.score);
    if (tied.length === 1) return top.repo;
    const named = tied.filter(
      (entry) =>
        plain(entry.repo.name).includes(plain(service.name)) || plain(service.name).includes(plain(entry.repo.name)),
    );
    return named.length === 1 ? (named[0]?.repo ?? null) : null;
  }

  private link(
    service: ServiceRow,
    values: { repoId?: string; repoUrl?: string },
    found: 'repo' | 'url',
    tried: string[],
  ): FindResult {
    this.store.write((tx) => tx.update(services).set(values).where(eq(services.id, service.id)).run());
    this.logger.log(`code for ${service.name} found: ${values.repoUrl ?? 'an imported Repo'}`);
    return { found, tried };
  }

  /** Where to look on the hosts: connected Connectors' accounts first, then owners of imported Repos. */
  private async owners(imported: (typeof repos.$inferSelect)[]): Promise<Omit<HostedName, 'name'>[]> {
    const out: Omit<HostedName, 'name'>[] = [];
    const add = (host: HostedName['host'], owner: string | null | undefined) => {
      if (owner && !out.some((other) => other.host === host && other.owner.toLowerCase() === owner.toLowerCase())) {
        out.push({ host, owner });
      }
    };
    const rows = this.store.db.select().from(connectors).all();
    const up = (id: ConnectorId) => rows.find((row) => row.id === id && row.status === HealthStatus.Ok);
    const bitbucket = up(ConnectorId.Bitbucket);
    if (bitbucket) add(GitHost.Bitbucket, parseJson<{ workspace?: string }>(bitbucket.config, {}).workspace);
    const github = up(ConnectorId.Github);
    if (github) {
      add(GitHost.Github, parseJson<{ org?: string | null }>(github.config, {}).org);
      add(GitHost.Github, github.login);
      for (const owner of await this.hosts.githubOwners()) add(GitHost.Github, owner);
    }
    const gitlab = up(ConnectorId.Gitlab);
    for (const repo of imported) {
      const owner = repo.remoteSlug?.split('/')[0];
      if (repo.host === GitHost.Github && github) add(GitHost.Github, owner);
      if (repo.host === GitHost.Bitbucket && bitbucket) add(GitHost.Bitbucket, owner);
      if (repo.host === GitHost.Gitlab && gitlab) add(GitHost.Gitlab, owner);
    }
    return out;
  }
}
