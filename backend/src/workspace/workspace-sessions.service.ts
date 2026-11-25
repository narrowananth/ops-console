import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  ActionActor,
  ActionKind,
  ActionOutcome,
  type CommitSession,
  type CommittedSession,
  type CreateRepoSession,
  createRepoSessionSchema,
  ErrorCode,
  type FolderTarget,
  type PrAction,
  PrActionState,
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
import { asBackground } from '../common/spawn-pool';
import { repos } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git, GitFailed } from '../repos/git';
import { FOLDER_OPENER, type FolderOpener } from './folder-opener';

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
    @Inject(FOLDER_OPENER) private readonly opener: FolderOpener,
    @Inject(SessionKinds) kinds: SessionKinds,
  ) {
    kinds.register(SessionKind.Repo, {
      workingDir: (session) => this.worktreeDir(session.id),
      ownWorktree: true,
      acceptsMessages: true,
      create: (body) => this.create(parseInput(createRepoSessionSchema, body, 'body')),
      prepare: async (session) => {
        await this.ensure(session);
        this.announceAction(session.id, PrActionState.Working);
      },
      refresh: (session) => this.refreshDefault(session).catch(() => undefined),
      // A run that worked elsewhere, such as a Verification in its scratch copy, says nothing about the Session's branch.
      afterRun: async (session, run) => {
        if (run.workingDir === this.worktreeDir(session.id)) await this.followBranch(session.id);
        this.announceAction(session.id);
      },
      removed: async (session) => {
        this.announceAction(session.id, PrActionState.NotSubmitted, session);
        await this.release(session.id);
      },
    });
    kinds.register(SessionKind.PrReview, {
      workingDir: (session) => this.folder(session.repoId),
      acceptsMessages: false,
    });
  }

  /** A PR action Session's run began or ended, or the Session was deleted: its state in the pull request view changes. */
  private announceAction(sessionId: string, started?: PrActionState, removed?: SessionRow): void {
    const row = removed ?? this.sessions.get(sessionId);
    if (row.prAction === null || row.repoId === null || row.prNumber === null) return;
    const state = started ?? (row.prActionSubmittedAt !== null ? PrActionState.Submitted : PrActionState.NotSubmitted);
    this.store.write((_tx, emit) =>
      emit('pull_request.action_changed', {
        repo_id: row.repoId as string,
        number: row.prNumber as number,
        action: row.prAction as PrAction,
        session_id: row.id,
        state,
      }),
    );
  }

  /** Where a `repo` Session works. */
  worktreeDir(sessionId: string): string {
    return path.join(this.dataDir, 'session-worktrees', sessionId);
  }

  async create(input: CreateRepoSession): Promise<Session> {
    const folder = this.folder(input.repo_id);
    const branches = await this.git.branches(folder);
    if (!branches.some((branch) => branch.name === input.branch)) {
      if (input.new_branch) {
        // The newest code first: a new branch starts where the default branch is on origin, not where the folder left it.
        const { defaultBranch } = this.repo(input.repo_id);
        await this.logged(
          null,
          folder,
          `git fetch origin ${defaultBranch} && git branch ${input.branch} origin/${defaultBranch}`,
          async () => {
            const base = await this.git.codeBase(folder, [defaultBranch], true);
            await this.git.createBranch(folder, input.branch, base.ref);
          },
        );
      } else if (input.from_origin) {
        await this.logged(
          null,
          folder,
          `git fetch origin ${input.branch} && git branch --track ${input.branch} origin/${input.branch}`,
          () => this.git.trackBranch(folder, input.branch, true),
        );
      } else {
        throw validationFailed(`invalid body: branch ${input.branch} is not in this Repo`);
      }
    }
    const row = this.sessions.create({
      kind: SessionKind.Repo,
      repoId: input.repo_id,
      branch: input.branch,
      model: input.model,
      effort: input.effort,
      access_mode: input.access_mode,
    });
    // The worktree starts from the default branch as last fetched, so the Session opens at once; the newest commits
    // follow in the background and, at the latest, before the first run's first tool (`refreshDefault`).
    try {
      await this.ensure(row, false);
    } catch (error) {
      this.sessions.remove(row.id);
      throw error;
    }
    void asBackground(() => this.followOrigin(row));
    return toSession(row, []);
  }

  /**
   * The Session's worktree, made when it is missing: the Repo's default branch is fetched from origin first, and a
   * Session on that branch starts at its newest commit on a detached HEAD, since the Repo's own folder may hold the
   * branch. A Session on another branch checks that branch out, moved forward to origin when it is behind.
   */
  async ensure(session: SessionRow, fetch = true): Promise<string> {
    const dir = this.worktreeDir(session.id);
    if (await isWorktree(dir)) return dir;
    const running = this.making.get(session.id);
    if (running) return running;
    const work = this.make(session, dir, fetch).finally(() => this.making.delete(session.id));
    this.making.set(session.id, work);
    return work;
  }

  /**
   * Moves a PR Session's worktree to the pull request's head commit, uncommitted changes travelling along. False when
   * the Session has no worktree yet. Throws `upstream_failed` with git's message when it cannot move.
   */
  async moveToCommit(session: SessionRow, sha: string): Promise<boolean> {
    const dir = this.worktreeDir(session.id);
    if (!(await isWorktree(dir))) return false;
    const repo = this.repo(session.repoId);
    await this.logged(session.id, repo.path, `git checkout --detach ${sha}`, async () => {
      // A run wrote in this folder: the daemon's `git` runs here only while it is still the worktree the console made.
      await this.git.requireWorktree(dir, repo.path);
      await this.git.checkoutDetached(dir, sha);
    });
    return true;
  }

  /**
   * Who has `branch` checked out: the Repo's own folder, which is the operator's and stays on it, another Session's
   * worktree, which a Session may share, or no one.
   */
  private async holder(repoPath: string, branch: string): Promise<'folder' | 'worktree' | null> {
    const holder = await this.git.worktreeOf(repoPath, branch);
    if (holder === null) return null;
    return holder === (await realpath(repoPath).catch(() => repoPath)) ? 'folder' : 'worktree';
  }

  /** The Session's worktree when it has one; null before its first run or when it was taken away. */
  async existingWorktree(sessionId: string): Promise<string | null> {
    const dir = this.worktreeDir(sessionId);
    return (await isWorktree(dir)) ? dir : null;
  }

  private async make(session: SessionRow, dir: string, fetch: boolean): Promise<string> {
    const repo = this.repo(session.repoId);
    // A PR action Session works at the pull request's head commit, on no branch of its own.
    if (session.prActionHeadSha !== null) {
      const head = session.prActionHeadSha;
      await this.logged(session.id, repo.path, `git worktree add --detach ${dir} ${head}`, () =>
        this.git.addWorktree(repo.path, dir, head),
      );
      return dir;
    }
    const branch = session.branch ?? repo.defaultBranch;
    const onDefault = branch === repo.defaultBranch;
    await this.logged(
      session.id,
      repo.path,
      `${fetch ? `git fetch origin ${repo.defaultBranch} && ` : ''}git worktree add ${onDefault ? '--detach ' : ''}${dir}${onDefault ? '' : ` ${branch}`}`,
      async () => {
        const base = fetch
          ? await this.git.codeBase(repo.path, [repo.defaultBranch])
          : await this.git.codeBaseKept(repo.path, [repo.defaultBranch]);
        const holder = onDefault ? null : await this.holder(repo.path, branch);
        if (onDefault) {
          await this.git.addSessionWorktree(repo.path, dir, null, base.ref);
        } else if (holder === 'folder') {
          // The operator's folder keeps the branch: the Session starts at its commit on a detached HEAD, moved forward
          // to origin when it is behind.
          await this.git.addSessionWorktree(repo.path, dir, null, branch);
          if (fetch) await this.git.pull(dir, branch);
        } else {
          await this.git.addSessionWorktree(repo.path, dir, branch, base.ref, holder === 'worktree');
          if (fetch) await this.git.pull(dir, branch);
        }
      },
    );
    return dir;
  }

  /** Moves a new Session's worktree forward to its branch on origin once the Session is open. Never throws. */
  private async followOrigin(session: SessionRow): Promise<void> {
    const repo = this.repo(session.repoId);
    await this.git
      .pull(this.worktreeDir(session.id), session.branch ?? repo.defaultBranch, true)
      .catch(() => undefined);
  }

  /**
   * The console fetches the Repo's default branch before each run, so the agent never fetches, and
   * `origin/<default branch>` is the newest commit when the agent reads it. A Session left clean on the default
   * branch's detached HEAD also moves forward to it. A failed fetch leaves the last fetched commit.
   */
  private async refreshDefault(session: SessionRow): Promise<void> {
    const repo = this.repo(session.repoId);
    const dir = this.worktreeDir(session.id);
    // A status git cannot read counts as changes: the worktree stays where it is and only the fetch runs.
    const follows =
      session.branch === repo.defaultBranch &&
      (await this.git.branchName(dir)) === null &&
      !(await this.git.isDirty(dir).catch(() => true));
    if (follows) await this.git.pull(dir, repo.defaultBranch);
    else await this.git.remoteHead(repo.path, repo.defaultBranch).catch(() => undefined);
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
    const dirty = await this.git.isDirty(folder).catch((error) => {
      throw new ApiError(
        502,
        ErrorCode.UpstreamFailed,
        error instanceof GitFailed && error.message ? error.message : 'git status failed',
      );
    });
    if (dirty) {
      await this.logged(sessionId, folder, `git stash push --include-untracked`, () =>
        this.git.stash(folder, `ops-console: before switching to ${branch}`),
      );
      stashed = true;
    }
    const holder = create ? null : await this.holder(repo.path, branch);
    await this.logged(
      sessionId,
      folder,
      holder === 'folder'
        ? `git checkout --detach ${branch}`
        : `git checkout ${create ? '-b ' : ''}${branch}${create && from ? ` ${from}` : ''}`,
      async () => {
        if (holder !== 'folder') return this.git.checkout(folder, branch, create, from, holder === 'worktree');
        await this.git.checkoutDetached(folder, branch);
        await this.git.pull(folder, branch);
      },
    );
    return {
      session: toSession(this.sessions.write(sessionId, { branch }), this.sessions.pullRequestsFor(sessionId)),
      stashed,
    };
  }

  /** The Session's worktree, or `invalid_state` when a repo Session has none yet. */
  private async worktreeOrThrow(sessionId: string): Promise<{ dir: string; branch: string }> {
    const session = this.sessions.get(sessionId);
    if (session.kind !== SessionKind.Repo || session.repoId === null) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Only a repo Session has a branch');
    }
    const dir = await this.existingWorktree(sessionId);
    if (dir === null) throw new ApiError(409, ErrorCode.InvalidState, 'The Session has no worktree yet');
    const branch = (await this.git.branchName(dir)) ?? session.branch;
    if (branch === null) throw new ApiError(409, ErrorCode.InvalidState, 'The Session is on no branch');
    return { dir, branch };
  }

  /**
   * Commits every change in the Session's worktree as the operator: with `message`, or one written from the files. With
   * `new_branch` the commit lands on a new branch made from the current one, and the Session follows it. The Repo's
   * git hooks are skipped, as in every scratch copy; the host's CI still checks the push.
   */
  async commit(sessionId: string, input: CommitSession): Promise<CommittedSession> {
    const session = this.sessions.get(sessionId);
    if (session.state !== SessionState.Idle && session.state !== SessionState.Failed) {
      throw new ApiError(409, ErrorCode.InvalidState, 'The Session is still running');
    }
    const { dir, branch } = await this.worktreeOrThrow(sessionId);
    const paths = await this.git.uncommittedPaths(dir);
    const files = paths.length;
    if (files === 0) throw new ApiError(409, ErrorCode.InvalidState, 'Nothing to commit');
    const message = input.message?.trim() || commitMessage(paths);
    let target = branch;
    if (input.new_branch) {
      target = await this.newBranchName(dir, message);
      await this.logged(sessionId, dir, `git checkout -b ${target}`, () => this.git.checkout(dir, target, true));
    }
    const sha = await this.logged(sessionId, dir, `git commit -m ${JSON.stringify(message)}`, () =>
      this.git.commitAll(dir, message),
    );
    if (sha === null) throw new ApiError(409, ErrorCode.InvalidState, 'Nothing to commit');
    if (target !== session.branch) this.sessions.write(sessionId, { branch: target });
    return { sha, branch: target, message, files };
  }

  /** `ops/<words of the message>`, with a number added when the branch exists. */
  private async newBranchName(dir: string, message: string): Promise<string> {
    const slug =
      message
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '') || 'changes';
    const taken = new Set((await this.git.branches(dir)).map((branch) => branch.name));
    for (let n = 1; ; n++) {
      const name = n === 1 ? `ops/${slug}` : `ops/${slug}-${n}`;
      if (!taken.has(name)) return name;
    }
  }

  /** Opens the Session's worktree in the operator's editor or file manager. */
  async openFolder(sessionId: string, target: FolderTarget): Promise<void> {
    const dir = this.worktreeDir(sessionId);
    const session = this.sessions.get(sessionId);
    const where = (await isWorktree(dir))
      ? dir
      : session.kind === SessionKind.Repo && session.repoId
        ? this.folder(session.repoId)
        : null;
    if (where === null) throw new ApiError(409, ErrorCode.InvalidState, 'The Session has no folder yet');
    await this.opener(where, target).catch(() => {
      throw new ApiError(502, ErrorCode.UpstreamFailed, 'Could not open the folder on this machine');
    });
  }

  /** The folder and branch the push reads: the Session's worktree and the branch checked out in it. */
  async pushTarget(sessionId: string): Promise<{ dir: string; branch: string }> {
    return this.worktreeOrThrow(sessionId);
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
  private async logged<T>(
    sessionId: string | null,
    folder: string,
    command: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const row = this.actionLog.start({
      sessionId,
      kind: ActionKind.Git,
      target: folder,
      command,
      isProd: false,
      actor: ActionActor.Operator,
    });
    try {
      const result = await action();
      this.actionLog.finish(row, ActionOutcome.Ok);
      return result;
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

/** A commit message from the files a commit holds: `Update a.ts, b.ts and 2 more`. */
export function commitMessage(names: string[]): string {
  const base = names.map((name) => name.split('/').at(-1) ?? name);
  if (base.length === 0) return 'Update files';
  const shown = base.slice(0, 3).join(', ');
  return base.length > 3 ? `Update ${shown} and ${base.length - 3} more` : `Update ${shown}`;
}
