import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, SessionKind } from '@ops-console/shared';
import { isNull } from 'drizzle-orm';
import { type JoinRepoInput, type RepoJoiner } from '../agent/pull-request-tool';
import { AgentRuntime } from '../agent/runtime';
import { SessionsService } from '../agent/sessions.service';
import { ApiError } from '../common/errors';
import { repos } from '../db/schema';
import { STORE, type Store } from '../db/store';

type RepoFacts = { id: string; name: string; path: string; remoteSlug: string | null; defaultBranch: string };

const clean = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');

/**
 * The imported Repos a name, path or Git URL means. A path beats a Git URL, and that beats a name; the first of these
 * that matches anything decides, so a name shared by two Repos does not stop an exact path.
 */
export function matchRepos(query: string, rows: RepoFacts[]): RepoFacts[] {
  const q = clean(query);
  if (q === '') return [];
  const where = (test: (row: RepoFacts) => boolean) => rows.filter(test);
  const byPath = where((row) => {
    const folder = clean(row.path);
    return q === folder || q.startsWith(`${folder}/`);
  });
  if (byPath.length > 0) return byPath;
  const bySlug = where((row) => {
    if (row.remoteSlug === null) return false;
    const slug = clean(row.remoteSlug);
    return q === slug || q.endsWith(`/${slug}`) || q.endsWith(`:${slug}`);
  });
  if (bySlug.length > 0) return bySlug;
  const last = q.split('/').filter(Boolean).at(-1) ?? q;
  return where((row) => clean(row.name) === q || clean(row.name) === last);
}

/**
 * Moves an Anonymous Session into an imported Repo when the agent asks and the operator approves. The Session then
 * runs in a worktree of the Repo like any `repo` Session: a branch, the Changes panel, commit hooks, the pull request.
 */
@Injectable()
export class RepoJoinService implements RepoJoiner {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AgentRuntime) runtime: AgentRuntime,
  ) {
    runtime.setRepoJoiner(this);
  }

  /** An Anonymous Session no Alert made: a Verification or Fix keeps working in its own clone. */
  offers(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session.kind === SessionKind.Anonymous && session.alertId === null;
  }

  describe(sessionId: string, input: JoinRepoInput): string {
    const repo = this.find(sessionId, input);
    return `Move this Session into the Repo ${repo.name} (${repo.path}): the agent then works in a worktree of its own, started from the newest ${repo.defaultBranch}`;
  }

  async join(sessionId: string, input: JoinRepoInput): Promise<{ repo: string; branch: string | null }> {
    const repo = this.find(sessionId, input);
    const branch = repo.defaultBranch;
    this.sessions.write(sessionId, { kind: SessionKind.Repo, repoId: repo.id, branch });
    return { repo: repo.name, branch };
  }

  private find(sessionId: string, input: JoinRepoInput): RepoFacts {
    if (!this.offers(sessionId)) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only an Anonymous Session joins a Repo');
    }
    const rows = this.store.db.select().from(repos).where(isNull(repos.removedAt)).all();
    const found = matchRepos(input.repo, rows);
    if (found.length === 0) {
      throw new ApiError(
        404,
        ErrorCode.NotFound,
        `no imported Repo matches "${input.repo}". Clone it into this folder if it is on a Git host, and tell the operator to import the Repo for branches and pull requests`,
      );
    }
    if (found.length > 1) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        `"${input.repo}" matches ${found.length} imported Repos: ${found.map((row) => `${row.name} (${path.basename(row.path)})`).join(', ')}. Ask the operator which one, then call again with its path`,
      );
    }
    return found[0] as RepoFacts;
  }
}
