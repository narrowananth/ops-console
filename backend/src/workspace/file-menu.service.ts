import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { type FileMenu, type FileMenuItem, SessionKind } from '@ops-console/shared';
import { eq, isNull } from 'drizzle-orm';
import { SessionsService } from '../agent/sessions.service';
import { repos } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git } from '../repos/git';
import { WorkspaceSessionsService } from './workspace-sessions.service';

/** Rows the menu returns: enough to scroll, few enough to render at once. */
const LIMIT = 30;
/** How long a folder's file list is reused, so typing a word does not list the folder once a letter. */
const KEEP_MS = 5000;

/**
 * The `@` menu of a Session. A Repo Session lists its own worktree's files; an Anonymous Session has no folder of
 * its own worth searching, so it lists the files of every imported Repo.
 */
@Injectable()
export class FileMenuService {
  private readonly listed = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(WorkspaceSessionsService) private readonly workspace: WorkspaceSessionsService,
  ) {}

  async menu(query: { session_id: string; q?: string }): Promise<FileMenu> {
    const session = this.sessions.get(query.session_id);
    const q = (query.q ?? '').trim().toLowerCase();
    let items: FileMenuItem[] = [];
    if (session.kind === SessionKind.Repo && session.repoId !== null) {
      const folder = (await this.workspace.existingWorktree(session.id)) ?? this.repoPath(session.repoId);
      if (folder) items = (await this.files(folder)).map((file) => this.item(file, null, null));
    } else if (session.kind === SessionKind.Anonymous) {
      const all = this.store.db.select().from(repos).where(isNull(repos.removedAt)).all();
      const lists = await Promise.all(
        all.map(async (repo) => (await this.files(repo.path)).map((file) => this.item(file, repo.name, repo.path))),
      );
      items = lists.flat();
    }
    return { items: rank(items, q).slice(0, LIMIT) };
  }

  private repoPath(repoId: string): string | null {
    return this.store.db.select({ path: repos.path }).from(repos).where(eq(repos.id, repoId)).get()?.path ?? null;
  }

  private item(file: string, repo: string | null, root: string | null): FileMenuItem {
    const dir = path.posix.dirname(file);
    return {
      path: root === null ? file : path.join(root, file),
      name: path.posix.basename(file),
      dir: dir === '.' ? '' : dir,
      repo,
    };
  }

  private files(folder: string): Promise<string[]> {
    const now = Date.now();
    const kept = this.listed.get(folder);
    if (kept && now - kept.at < KEEP_MS) return kept.files;
    const files = this.git.files(folder);
    this.listed.set(folder, { at: now, files });
    return files;
  }
}

/**
 * A file whose name starts with the text comes first, then names that hold it, then paths that do; each shorter path
 * first, then A to Z. No text lists the shallowest files.
 */
function rank(items: FileMenuItem[], q: string): FileMenuItem[] {
  const score = (item: FileMenuItem): number | null => {
    if (q === '') return 0;
    const name = item.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return `${item.dir}/${item.name}`.toLowerCase().includes(q) ? 2 : null;
  };
  return items
    .flatMap((item) => {
      const found = score(item);
      return found === null ? [] : [{ item, found }];
    })
    .sort(
      (a, b) =>
        a.found - b.found ||
        a.item.path.length - b.item.path.length ||
        a.item.path.localeCompare(b.item.path, undefined, { sensitivity: 'base' }),
    )
    .map((entry) => entry.item);
}
