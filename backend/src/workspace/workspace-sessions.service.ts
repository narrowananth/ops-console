import { Inject, Injectable } from '@nestjs/common';
import {
  ActionActor,
  ActionKind,
  ActionOutcome,
  type CreateRepoSession,
  createRepoSessionSchema,
  ErrorCode,
  type Session,
  SessionKind,
  SessionState,
} from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { ActionLogService } from '../action-log/action-log.service';
import { SessionKinds } from '../agent/session-kinds';
import { SessionsService, toSession } from '../agent/sessions.service';
import { ApiError, parseInput, validationFailed } from '../common/errors';
import { repos, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git, GitFailed } from '../repos/git';

/** Sessions that run in a Repo: where they run, and moving their branch. */
@Injectable()
export class WorkspaceSessionsService {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(SessionKinds) kinds: SessionKinds,
  ) {
    kinds.register(SessionKind.Repo, {
      workingDir: (session) => this.folder(session.repoId),
      acceptsMessages: true,
      create: (body) => this.create(parseInput(createRepoSessionSchema, body, 'body')),
    });
    kinds.register(SessionKind.PrReview, {
      workingDir: (session) => this.folder(session.repoId),
      acceptsMessages: false,
    });
  }

  async create(input: CreateRepoSession): Promise<Session> {
    const folder = this.folder(input.repo_id);
    const branches = await this.git.branches(folder);
    if (!branches.some((branch) => branch.name === input.branch)) {
      throw validationFailed(`invalid body: branch ${input.branch} is not in this Repo`);
    }
    return toSession(
      this.sessions.create({
        kind: SessionKind.Repo,
        repoId: input.repo_id,
        branch: input.branch,
        model: input.model,
        effort: input.effort,
        access_mode: input.access_mode,
      }),
    );
  }

  /** Stashes uncommitted changes, then checks out `branch`, or makes it from the current one with `create`. */
  async checkout(sessionId: string, branch: string, create: boolean): Promise<{ session: Session; stashed: boolean }> {
    const session = this.sessions.get(sessionId);
    if (session.kind !== SessionKind.Repo || session.repoId === null) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only a repo Session has a branch');
    }
    if (session.state !== SessionState.Idle && session.state !== SessionState.Failed) {
      throw new ApiError(409, ErrorCode.InvalidState, 'The Session is still running');
    }
    const busy = this.store.db
      .select({ state: sessions.state })
      .from(sessions)
      .where(eq(sessions.repoId, session.repoId))
      .all()
      .some((row) => row.state === SessionState.Working || row.state === SessionState.WaitingApproval);
    if (busy) throw new ApiError(409, ErrorCode.InvalidState, 'A Session in this Repo is running');

    const folder = this.folder(session.repoId);
    let stashed = false;
    if (await this.git.isDirty(folder)) {
      await this.logged(sessionId, folder, `git stash push --include-untracked`, () =>
        this.git.stash(folder, `ops-console: before switching to ${branch}`),
      );
      stashed = true;
    }
    await this.logged(sessionId, folder, `git checkout ${create ? '-b ' : ''}${branch}`, () =>
      this.git.checkout(folder, branch, create),
    );
    return { session: toSession(this.sessions.write(sessionId, { branch })), stashed };
  }

  /** The Action Log row exists before git runs; a refusal from git becomes `upstream_failed`. */
  private async logged(sessionId: string, folder: string, command: string, action: () => Promise<void>): Promise<void> {
    const row = this.actionLog.start({
      sessionId,
      kind: ActionKind.Git,
      target: folder,
      command,
      isProd: false,
      actor: ActionActor.Operator,
    });
    try {
      await action();
      this.actionLog.finish(row, ActionOutcome.Ok);
    } catch (error) {
      const message = error instanceof GitFailed && error.message ? error.message : 'git failed';
      this.actionLog.finish(row, ActionOutcome.Failed, message);
      throw new ApiError(502, ErrorCode.UpstreamFailed, message);
    }
  }

  private folder(repoId: string | null): string {
    const row =
      repoId === null
        ? undefined
        : this.store.db.select({ path: repos.path }).from(repos).where(eq(repos.id, repoId)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Repo');
    return row.path;
  }
}
