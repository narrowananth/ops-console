import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConnectorId, GitHost, HealthStatus } from '@ops-console/shared';
import { eq, isNull } from 'drizzle-orm';
import { connectors, repos, services } from '../db/schema';
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

/** `gh` for GitHub; `git ls-remote` over SSH, with no prompt, for GitLab and Bitbucket. */
export class CliCodeHosts implements CodeHosts {
  async find(repo: HostedName): Promise<string | null> {
    try {
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

const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Finds a Service's code with no help from the operator, first match wins: an imported Repo of the same name, a git
 * folder of that name next to an imported Repo (imported then), then a repository of that name on a connected Git
 * host, under the Bitbucket workspace, the GitHub login and its organizations, or an owner of an imported Repo.
 */
@Injectable()
export class CodeFinder {
  private readonly logger = new Logger('monitor');
  private readonly running = new Map<string, Promise<FindResult>>();
  /** Services already looked for since start; a Scan does not look again. */
  private readonly looked = new Set<string>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
    @Inject(ReposService) private readonly repos: ReposService,
    @Inject(CODE_HOSTS) private readonly hosts: CodeHosts,
  ) {}

  /** After a Scan: looks once for each Service with no code, in the background. */
  lookForUnlinked(): void {
    const unlinked = this.store.db
      .select()
      .from(services)
      .all()
      .filter((row) => row.repoId === null && row.repoUrl === null && !this.looked.has(row.id));
    for (const row of unlinked) {
      void this.find(row.id).catch((error) =>
        this.logger.warn(`code for ${row.name} not looked for: ${error instanceof Error ? error.message : error}`),
      );
    }
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
    this.looked.add(serviceId);
    const service = this.store.db.select().from(services).where(eq(services.id, serviceId)).get();
    if (!service) return { found: null, tried: [] };
    if (service.repoId) return { found: 'repo', tried: [] };
    if (service.repoUrl) return { found: 'url', tried: [] };
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

    for (const candidate of await this.owners(imported)) {
      const repo = { ...candidate, name: service.name };
      tried.push(`${HOST_NAME[repo.host]}/${repo.owner}/${repo.name}`);
      const url = await this.hosts.find(repo);
      if (url) return this.link(service, { repoUrl: url }, 'url', tried);
    }
    return { found: null, tried };
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
