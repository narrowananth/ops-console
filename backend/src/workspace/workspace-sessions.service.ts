import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
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
import { type SessionRow, SessionsService, toSession } from '../agent/sessions.service';
import { DATA_DIR } from '../common/data-dir';
import { ApiError, parseInput, validationFailed } from '../common/errors';
import { repos } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git, GitFailed } from '../repos/git';

/**
 * Sessions that run in a Repo. Each has a git worktree of its own under the data folder, so Sessions on different
 * branches work at once and nothing is checked out in the operator's own folder. The worktree starts from the newest
 * commit of the Repo's default branch, fetched from origin.
 */
@Injectable()
export class WorkspaceSessionsService {
  /** Worktrees being made, so two requests for one Session make it once. */
  private readonly making = new Map<string, Promise<string>>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(SessionKinds) kinds: SessionKinds,
  ) {
    kinds.register(SessionKind.Repo, {
      workingDir: (session) => this.worktreeDir(session.id),
      ownWorktree: true,
      acceptsMessages: true,
      create: (body) => this.create(parseInput(createRepoSessionSchema, body, 'body')),
      prepare: async (session) => {
        await this.ensure(session);
        await this.refreshDefault(session);
      },
      // A run that worked elsewhere, such as a Verification in its scratch copy, says nothing about the Session's branch.
      afterRun: async (session, run) => {
        if (run.workingDir === this.worktreeDir(session.id)) await this.followBranch(session.id);
      },
      removed: (session) => this.release(session.id),
    });
    kinds.register(SessionKind.PrReview, {
      workingDir: (session) => this.folder(session.repoId),
      acceptsMessages: false,
    });
  }

  /** Where a `repo` Session works. */
  worktreeDir(sessionId: string): string {
    return path.join(this.dataDir, 'session-worktrees', sessionId);
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
    const row = this.sessions.create({
      kind: SessionKind.Repo,
      repoId: input.repo_id,
      branch: input.branch,
      model: input.model,
      effort: input.effort,
      access_mode: input.access_mode,
    });
    // The newest code first: the Session starts from the fetched default branch, not from what the folder had.
    try {
      await this.ensure(row);
    } catch (error) {
      this.sessions.remove(row.id);
      throw error;
    }
    return toSession(row);
  }

  /**
   * The Session's worktree, made when it is missing: the Repo's default branch is fetched from origin first, and a
   * Session on that branch starts at its newest commit on a detached HEAD, since the Repo's own folder may hold the
   * branch. A Session on another branch checks that branch out, moved forward to origin when it is behind.
   */
  async ensure(session: SessionRow): Promise<string> {
    const dir = this.worktreeDir(session.id);
    if (await isWorktree(dir)) return dir;
    const running = this.making.get(session.id);
    if (running) return running;
    const work = this.make(session, dir).finally(() => this.making.delete(session.id));
    this.making.set(session.id, work);
    return work;
  }

  /**
   * Whether another worktree already has `branch` checked out, which a Session may share. The Repo's own folder is the
   * operator's: a branch it holds stays there, and this throws.
   */
  private async sharesBranch(repoPath: string, branch: string): Promise<boolean> {
    const holder = await this.git.worktreeOf(repoPath, branch);
    if (holder !== null && holder === (await realpath(repoPath).catch(() => repoPath))) {
      throw new GitFailed(
        `${branch} is checked out in the Repo's own folder. Switch that folder to another branch, then try again`,
      );
    }
    return holder !== null;
  }

  /** The Session's worktree when it has one; null before its first run or when it was taken away. */
  async existingWorktree(sessionId: string): Promise<string | null> {
    const dir = this.worktreeDir(sessionId);
    return (await isWorktree(dir)) ? dir : null;
  }

  private async make(session: SessionRow, dir: string): Promise<string> {
    const repo = this.repo(session.repoId);
    const branch = session.branch ?? repo.defaultBranch;
    const onDefault = branch === repo.defaultBranch;
    await this.logged(
      session.id,
      repo.path,
      `git fetch origin ${repo.defaultBranch} && git worktree add ${onDefault ? '--detach ' : ''}${dir}${onDefault ? '' : ` ${branch}`}`,
      async () => {
        const base = await this.git.codeBase(repo.path, [repo.defaultBranch]);
        const shared = onDefault ? false : await this.sharesBranch(repo.path, branch);
        await this.git.addSessionWorktree(repo.path, dir, onDefault ? null : branch, base.ref, shared);
        if (!onDefault) await this.git.pull(dir, branch);
      },
    );
    return dir;
  }

  /** A Session left on the default branch's detached HEAD starts each run at the newest commit of it. */
  private async refreshDefault(session: SessionRow): Promise<void> {
    const repo = this.repo(session.repoId);
    const dir = this.worktreeDir(session.id);
    if (session.branch !== repo.defaultBranch || (await this.git.branchName(dir)) !== null) return;
    if (await this.git.isDirty(dir)) return;
    await this.git.pull(dir, repo.defaultBranch);
  }

  /** Takes the Session's worktree away with the Session; its branch and commits stay in the Repo. */
  private async release(sessionId: string): Promise<void> {
    const dir = this.worktreeDir(sessionId);
    if (await isWorktree(dir)) await this.git.removeWorktree(dir);
  }

  /** Stashes the worktree's uncommitted changes, then checks out `branch` there, or makes it from the current one with `create`. */
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
    const repo = this.repo(session.repoId);
    const folder = await this.ensure(session);
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
      async () =>
        this.git.checkout(folder, branch, create, from, !create && (await this.sharesBranch(repo.path, branch))),
    );
    return { session: toSession(this.sessions.write(sessionId, { branch })), stashed };
  }

  /**
   * What the Session's own worktree changes against where it forked from the default branch. Nothing before the
   * Session has a worktree. Other Sessions' branches are in their own worktrees, so none of their changes show here.
   */
  async diff(sessionId: string): Promise<SessionDiff> {
    const session = this.sessions.get(sessionId);
    if (session.kind !== SessionKind.Repo || session.repoId === null) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only a repo Session has a diff');
    }
    const repo = this.repo(session.repoId);
    const dir = this.worktreeDir(sessionId);
    if (!(await isWorktree(dir))) return { branch: session.branch, base: null, files: [], additions: 0, deletions: 0 };
    return this.git.changes(dir, repo.defaultBranch, session.branch);
  }

  /**
   * Moves the Session to the branch its worktree is on, as when the agent made a branch for its fix. A detached HEAD,
   * which a Session on the default branch starts with, leaves the Session's branch as it is.
   */
  async followBranch(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session.kind !== SessionKind.Repo || session.repoId === null) return;
    const dir = this.worktreeDir(sessionId);
    if (!(await isWorktree(dir))) return;
    const branch = await this.git.branchName(dir);
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

/** Whether `dir` is a git worktree: its `.git` is a file. */
async function isWorktree(dir: string): Promise<boolean> {
  return stat(path.join(dir, '.git')).then(
    (info) => info.isFile(),
    () => false,
  );
}
