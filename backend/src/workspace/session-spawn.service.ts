import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, RunOutcome, SessionKind, SessionState } from '@ops-console/shared';
import { isNull } from 'drizzle-orm';
import type { SessionSpawner, SpawnedEntry, SpawnSessionsInput } from '../agent/pull-request-tool';
import { AgentRuntime } from '../agent/runtime';
import { SessionsService } from '../agent/sessions.service';
import { ApiError } from '../common/errors';
import { repos } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { matchRepos, type RepoFacts } from './repo-join.service';

/** What each started Session is told after its task: it is one of a batch, and how its work reaches a pull request. */
const batchNote = (parentTitle: string) =>
  `You are one of several Sessions the operator approved at once, each in its own Repo, started from the Session "${parentTitle}". Work only in this Repo: the other Repos' tasks belong to other Sessions, so leave them alone. Do the work on a new branch, not on the default branch: make one with git switch -c, commit the change (the repo's commit hooks run and must pass), and when the work is done call the open_pull_request tool. The console pushes the branch and opens the pull request at once, with no Approval. If that tool is not in your tool list, the Repo has no Git host the console can open on: say so, and leave the commit on its branch.`;

const firstLine = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

/**
 * Starts a Session in each of several imported Repos when the agent asks and the operator approves the whole list.
 * Each Session is a `repo` Session like any other: its own worktree, branch and pull request, in the parent's model,
 * effort and Access mode. It cannot spawn in turn.
 */
@Injectable()
export class SessionSpawnService implements SessionSpawner {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
  ) {
    runtime.setSessionSpawner(this);
  }

  /** A chat in an Anonymous or `repo` Session that no Alert made and no other Session spawned. */
  offers(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return (
      (session.kind === SessionKind.Anonymous || session.kind === SessionKind.Repo) &&
      session.alertId === null &&
      session.spawnedBySessionId === null
    );
  }

  describe(sessionId: string, input: SpawnSessionsInput): string {
    const found = this.resolve(sessionId, input);
    const lines = found.map(
      ({ repo, task }) =>
        `${repo.name} (${repo.path}): ${firstLine(task)}${task.includes('\n') ? ' …' : ''} [${task.length} characters]`,
    );
    return `Start ${found.length} Session${found.length === 1 ? '' : 's'}, each in its own worktree, started from the newest ${found.length === 1 ? 'default branch' : 'default branches'}:\n${lines.join('\n')}`;
  }

  async spawn(sessionId: string, input: SpawnSessionsInput, callId: string): Promise<SpawnedEntry[]> {
    const found = this.resolve(sessionId, input);
    const parent = this.sessions.get(sessionId);
    const started: SpawnedEntry[] = [];
    for (const { repo, task } of found) {
      try {
        const child = this.sessions.create({
          kind: SessionKind.Repo,
          repoId: repo.id,
          branch: repo.defaultBranch,
          model: parent.model,
          effort: parent.effort,
          access_mode: parent.accessMode,
          spawnedBy: { sessionId, callId },
        });
        started.push({ repo: repo.name, sessionId: child.id, error: null });
        try {
          // The task leads, so the Session is named for it.
          this.runtime.send(child.id, `${task}\n\n${batchNote(parent.title)}`);
        } catch (error) {
          // The Session stays, failed, with the reason on its own page.
          const why = error instanceof Error ? error.message : 'the run did not start';
          this.sessions.setFailure(child.id, why);
          this.sessions.write(child.id, { state: SessionState.Failed, runOutcome: RunOutcome.Failed });
        }
      } catch (error) {
        started.push({
          repo: repo.name,
          sessionId: null,
          error: error instanceof Error ? error.message : 'the Session did not start',
        });
      }
    }
    return started;
  }

  /** Every entry's Repo, or the reason the whole list is refused. */
  private resolve(sessionId: string, input: SpawnSessionsInput): { repo: RepoFacts; task: string }[] {
    if (!this.offers(sessionId)) {
      throw new ApiError(409, ErrorCode.InvalidState, 'This Session cannot start other Sessions');
    }
    const own = this.sessions.get(sessionId).repoId;
    const rows = this.store.db.select().from(repos).where(isNull(repos.removedAt)).all();
    const seen = new Set<string>();
    return input.sessions.map(({ repo: query, task }) => {
      const found = matchRepos(query, rows);
      if (found.length === 0) {
        throw new ApiError(404, ErrorCode.NotFound, `no imported Repo matches "${query}"`);
      }
      if (found.length > 1) {
        throw new ApiError(
          409,
          ErrorCode.InvalidState,
          `"${query}" matches ${found.length} imported Repos: ${found.map((row) => `${row.name} (${row.path})`).join(', ')}. Ask the operator which one, then call again with its path`,
        );
      }
      const repo = found[0] as RepoFacts;
      if (repo.id === own) {
        throw new ApiError(409, ErrorCode.InvalidState, `${repo.name} is this Session's own Repo: do that task here`);
      }
      if (seen.has(repo.id)) {
        throw new ApiError(409, ErrorCode.InvalidState, `${repo.name} is listed twice: give each Repo one task`);
      }
      seen.add(repo.id);
      return { repo, task };
    });
  }
}
