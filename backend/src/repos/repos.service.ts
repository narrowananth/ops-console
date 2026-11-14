import { homedir } from 'node:os';
import path from 'node:path';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ErrorCode, RemovedRepoSessions, type Repo, SessionState } from '@ops-console/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { repos, services, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git, parseRemote } from './git';

type Row = typeof repos.$inferSelect;

/** A Session in one of these has a run going; a daemon restart fails it (`02-settings-agents` Behavior 18). */
const RUNNING = [SessionState.Working, SessionState.WaitingInput, SessionState.WaitingApproval];

@Injectable()
export class ReposService implements OnApplicationBootstrap {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
  ) {}

  /** The pull request list reads the stored host and slug, so they are right before anyone opens the Repos page. */
  async onApplicationBootstrap(): Promise<void> {
    await this.syncRemotes();
  }

  async list(): Promise<{ data: Repo[]; meta: { next_cursor: null } }> {
    await this.syncRemotes();
    const rows = this.store.db.select().from(repos).where(isNull(repos.removedAt)).all();
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return { data: await Promise.all(rows.map((row) => this.view(row))), meta: { next_cursor: null } };
  }

  /** Id and folder of every Repo, for readers that only need where to look. */
  folders(): { id: string; path: string }[] {
    return this.store.db.select({ id: repos.id, path: repos.path }).from(repos).where(isNull(repos.removedAt)).all();
  }

  async get(id: string): Promise<Repo> {
    return this.view(this.row(id));
  }

  /**
   * Follows each Repo's `origin`: a remote moved to another workspace or SSH host (vajro to superfans-io) changes
   * the stored host and `owner/name`. A folder that is gone, or an `origin` that names no known host, changes nothing.
   */
  async syncRemotes(): Promise<void> {
    const rows = this.store.db.select().from(repos).where(isNull(repos.removedAt)).all();
    await Promise.all(
      rows.map(async (row) => {
        if ((await this.git.topFolder(row.path)) === null) return;
        const { host, slug } = parseRemote(await this.git.originUrl(row.path));
        if (slug === null || (host === row.host && slug === row.remoteSlug)) return;
        this.store.write((tx) => {
          tx.update(repos).set({ host, remoteSlug: slug }).where(eq(repos.id, row.id)).run();
        });
      }),
    );
  }

  /** Stores the top folder of the repository holding `rawPath`. Git is read, never changed. */
  async import(rawPath: string): Promise<Repo> {
    const folder = await this.git.topFolder(expandHome(rawPath));
    if (folder === null) throw new ApiError(400, ErrorCode.NotARepo, 'Not a git repository');
    const existing = this.store.db.select().from(repos).where(eq(repos.path, folder)).get();
    if (existing && existing.removedAt === null) {
      throw new ApiError(409, ErrorCode.Duplicate, `${existing.name} is already imported`);
    }
    const { host, slug } = parseRemote(await this.git.originUrl(folder));
    const defaultBranch = (await this.git.defaultBranch(folder)) ?? 'main';
    // A Repo removed with its Sessions kept comes back under its old id, so they come back with it.
    const id = existing?.id ?? crypto.randomUUID();
    this.store.write((tx) => {
      if (existing) {
        tx.update(repos).set({ host, remoteSlug: slug, defaultBranch, removedAt: null }).where(eq(repos.id, id)).run();
      } else {
        tx.insert(repos)
          .values({ id, name: path.basename(folder), path: folder, host, remoteSlug: slug, defaultBranch })
          .run();
      }
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

  /**
   * Takes the Repo off the list and leaves the folder alone. With Sessions, the operator says what happens to them:
   * kept, they hide with the Repo and a running one finishes unseen; deleted, they go with it, once none is running.
   * Either way its Services lose the link.
   */
  remove(id: string, kept?: RemovedRepoSessions): void {
    const row = this.row(id);
    const inRepo = this.store.db
      .select({ id: sessions.id, state: sessions.state })
      .from(sessions)
      .where(eq(sessions.repoId, id))
      .all();
    if (inRepo.length > 0 && kept === undefined) {
      throw new ApiError(
        409,
        ErrorCode.RepoHasSessions,
        `${row.name} has ${inRepo.length} Sessions: say whether to keep or delete them`,
      );
    }
    if (kept === RemovedRepoSessions.Delete && inRepo.some((session) => RUNNING.includes(session.state))) {
      throw new ApiError(
        409,
        ErrorCode.SessionBusy,
        `A Session in ${row.name} is still running: keep the Sessions, or wait for it to end`,
      );
    }
    this.store.write((tx) => {
      tx.update(services).set({ repoId: null }).where(eq(services.repoId, id)).run();
      if (inRepo.length > 0 && kept === RemovedRepoSessions.Keep) {
        tx.update(repos).set({ removedAt: new Date().toISOString() }).where(eq(repos.id, id)).run();
        return;
      }
      tx.delete(sessions).where(eq(sessions.repoId, id)).run();
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
      session_count:
        this.store.db.select({ n: count() }).from(sessions).where(eq(sessions.repoId, row.id)).get()?.n ?? 0,
    };
  }

  private row(id: string): Row {
    const row = this.store.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.removedAt)))
      .get();
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
