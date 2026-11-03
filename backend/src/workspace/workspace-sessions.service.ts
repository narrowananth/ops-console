import { Inject, Injectable } from '@nestjs/common';
import {
  ActionActor,
  ActionKind,
  ActionOutcome,
  type CreateRepoSession,
  createRepoSessionSchema,
  ErrorCode,
  type Session,
  type SessionDiff,
  SessionKind,
  SessionState,
} from '@ops-console/shared';
import { and, eq, isNull } from 'drizzle-orm';
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
      afterRun: (session) => this.followBranch(session.id).then(() => {}),
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
      if (!input.from_origin) throw validationFailed(`invalid body: branch ${input.branch} is not in this Repo`);
      await this.logged(
        null,
        folder,
        `git fetch origin ${input.branch} && git branch --track ${input.branch} origin/${input.branch}`,
        () => this.git.trackBranch(folder, input.branch),
      );
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
  async checkout(
    sessionId: string,
    branch: string,
    create: boolean,
    from?: string,
  ): Promise<{ session: Session; stashed: boolean }> {
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
    await this.logged(
      sessionId,
      folder,
      `git checkout ${create ? '-b ' : ''}${branch}${create && from ? ` ${from}` : ''}`,
      () => this.git.checkout(folder, branch, create, from),
    );
    return { session: toSession(this.sessions.write(sessionId, { branch })), stashed };
  }

  /**
   * What the Session's branch changes, read from the Repo folder now. Reading it also catches the Session up with a
   * branch the agent checked out itself.
   */
  async diff(sessionId: string): Promise<SessionDiff> {
    const session = this.sessions.get(sessionId);
    if (session.kind !== SessionKind.Repo || session.repoId === null) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only a repo Session has a diff');
    }
    const repo = this.repo(session.repoId);
    const changes = await this.git.changes(repo.path, repo.defaultBranch);
    if (changes.branch !== null && changes.branch !== session.branch) this.follow(session.id, changes.branch);
    return changes;
  }

  /**
   * Writes the branch checked out in the Repo onto the Session, as after a run in which the agent made and switched to
   * a branch for its fix. A detached HEAD leaves the Session's branch as it was.
   */
  async followBranch(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session.kind !== SessionKind.Repo || session.repoId === null) return;
    const branch = await this.git.branchName(this.folder(session.repoId));
    if (branch !== null && branch !== session.branch) this.follow(session.id, branch);
  }

  /** Only an idle or failed Session moves: a running one may be mid-checkout. */
  private follow(sessionId: string, branch: string): void {
    const now = this.sessions.get(sessionId);
    if (now.state !== SessionState.Idle && now.state !== SessionState.Failed) return;
    this.sessions.write(sessionId, { branch });
  }

  /** The Action Log row exists before git runs; a refusal from git becomes `upstream_failed`. */
  private async logged(
    sessionId: string | null,
    folder: string,
    command: string,
    action: () => Promise<void>,
  ): Promise<void> {
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
    return this.repo(repoId).path;
  }

  private repo(repoId: string | null): { path: string; defaultBranch: string } {
    const row =
      repoId === null
        ? undefined
        : this.store.db
            .select({ path: repos.path, defaultBranch: repos.defaultBranch })
            .from(repos)
            .where(and(eq(repos.id, repoId), isNull(repos.removedAt)))
            .get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Repo');
    return row;
  }
}
