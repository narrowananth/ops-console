import { homedir } from 'node:os';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, type Repo } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { repos, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git, parseRemote } from './git';

type Row = typeof repos.$inferSelect;

@Injectable()
export class ReposService {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
  ) {}

  async list(): Promise<{ data: Repo[]; meta: { next_cursor: null } }> {
    const rows = this.store.db.select().from(repos).all();
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return { data: await Promise.all(rows.map((row) => this.view(row))), meta: { next_cursor: null } };
  }

  /** Id and folder of every Repo, for readers that only need where to look. */
  folders(): { id: string; path: string }[] {
    return this.store.db.select({ id: repos.id, path: repos.path }).from(repos).all();
  }

  async get(id: string): Promise<Repo> {
    return this.view(this.row(id));
  }

  /** Stores the top folder of the repository holding `rawPath`. Git is read, never changed. */
  async import(rawPath: string): Promise<Repo> {
    const folder = await this.git.topFolder(expandHome(rawPath));
    if (folder === null) throw new ApiError(400, ErrorCode.NotARepo, 'Not a git repository');
    const existing = this.store.db.select().from(repos).where(eq(repos.path, folder)).get();
    if (existing) throw new ApiError(409, ErrorCode.Duplicate, `${existing.name} is already imported`);
    const { host, slug } = parseRemote(await this.git.originUrl(folder));
    const defaultBranch = (await this.git.defaultBranch(folder)) ?? 'main';
    const id = crypto.randomUUID();
    this.store.write((tx) => {
      tx.insert(repos)
        .values({ id, name: path.basename(folder), path: folder, host, remoteSlug: slug, defaultBranch })
        .run();
    });
    return this.get(id);
  }

  /** Changes the display name only. */
  async rename(id: string, name: string): Promise<Repo> {
    this.row(id);
    this.store.write((tx) => {
      tx.update(repos).set({ name }).where(eq(repos.id, id)).run();
    });
    return this.get(id);
  }

  /** Deletes the row and leaves the folder alone. A Repo with Sessions stays. */
  remove(id: string): void {
    this.row(id);
    if (this.store.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.repoId, id)).get()) {
      throw new ApiError(409, ErrorCode.RepoHasSessions, 'Delete the Sessions in this Repo first');
    }
    this.store.write((tx) => {
      tx.delete(repos).where(eq(repos.id, id)).run();
    });
  }

  async branches(id: string): Promise<{ name: string; current: boolean }[]> {
    const row = this.row(id);
    if ((await this.git.topFolder(row.path)) === null) {
      throw new ApiError(404, ErrorCode.NotFound, `${row.name} is not on this machine any more`);
    }
    return this.git.branches(row.path);
  }

  private async view(row: Row): Promise<Repo> {
    const missing = (await this.git.topFolder(row.path)) === null;
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      host: row.host,
      remote_slug: row.remoteSlug,
      default_branch: row.defaultBranch,
      created_at: row.createdAt,
      branch: missing ? null : await this.git.currentBranch(row.path),
      dirty: missing ? false : await this.git.isDirty(row.path),
      missing,
    };
  }

  private row(id: string): Row {
    const row = this.store.db.select().from(repos).where(eq(repos.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Repo');
    return row;
  }
}

/** A leading `~` is the home folder; a relative path stays relative to the daemon. */
export function expandHome(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '~') return homedir();
  return trimmed.startsWith('~/') ? path.join(homedir(), trimmed.slice(2)) : trimmed;
}
