import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  ActionActor,
  ActionKind,
  ActionOutcome,
  type CreateAnonymousSession,
  createAnonymousSessionSchema,
  ErrorCode,
  type Session,
  SessionKind,
} from '@ops-console/shared';
import { ActionLogService } from '../action-log/action-log.service';
import { SessionKinds } from '../agent/session-kinds';
import { type SessionRow, SessionsService, toSession } from '../agent/sessions.service';
import { DATA_DIR } from '../common/data-dir';
import { ApiError, parseInput } from '../common/errors';
import { GIT, Git, GitFailed } from '../repos/git';

/** Sessions with no imported Repo. Each works in its own folder under the data directory, and may clone into it. */
@Injectable()
export class AnonymousSessionsService {
  constructor(
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(GIT) private readonly git: Git,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(SessionKinds) kinds: SessionKinds,
  ) {
    kinds.register(SessionKind.Anonymous, {
      workingDir: (session) => this.folder(session.id),
      acceptsMessages: true,
      create: (body) => this.create(parseInput(createAnonymousSessionSchema, body, 'body')),
    });
  }

  create(input: Omit<CreateAnonymousSession, 'kind'>): Session {
    const row = this.sessions.create({
      kind: SessionKind.Anonymous,
      model: input.model,
      effort: input.effort,
      access_mode: input.access_mode,
    });
    this.folder(row.id);
    return toSession(input.title ? this.sessions.write(row.id, { title: input.title }) : row);
  }

  /** The Session's folder, made when missing so a run always has somewhere to work. */
  folder(sessionId: string): string {
    const dir = path.join(this.dataDir, 'anonymous', sessionId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Clones `url` into the Session's empty folder and records the branch it landed on. */
  async clone(sessionId: string, url: string): Promise<SessionRow> {
    const dir = this.folder(sessionId);
    // A password in the URL stays out of the Action Log.
    const shown = url.replace(/\/\/[^@/]+@/, '//');
    await this.logged(sessionId, dir, `git clone ${shown}`, () => this.git.clone(url, dir));
    return this.sessions.write(sessionId, { branch: await this.git.currentBranch(dir) });
  }

  /** Checks out `branch` in the Session's clone, making it from the current one when it does not exist. */
  async checkout(sessionId: string, branch: string): Promise<SessionRow> {
    const dir = this.folder(sessionId);
    const exists = (await this.git.branches(dir)).some((candidate) => candidate.name === branch);
    await this.logged(sessionId, dir, `git checkout ${exists ? '' : '-b '}${branch}`, () =>
      this.git.checkout(dir, branch, !exists),
    );
    return this.sessions.write(sessionId, { branch });
  }

  /** The Action Log row exists before git runs; a refusal from git becomes `upstream_failed`. */
  private async logged(sessionId: string, dir: string, command: string, action: () => Promise<void>): Promise<void> {
    const row = this.actionLog.start({
      sessionId,
      kind: ActionKind.Git,
      target: dir,
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
      throw new ApiError(502, ErrorCode.UpstreamFailed, `${command}: ${message}`);
    }
  }
}
