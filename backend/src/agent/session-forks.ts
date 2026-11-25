import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, type Session, SessionKind } from '@ops-console/shared';
import { AccountsService } from '../accounts/accounts.service';
import { ApiError } from '../common/errors';
import { SessionKinds } from './session-kinds';
import { SessionsService } from './sessions.service';
import { Transcripts } from './transcripts';

const FORKABLE: SessionKind[] = [SessionKind.Repo, SessionKind.Anonymous];

/**
 * Fork from this response: a new Session of the same kind, Repo, branch and settings, whose conversation is the
 * source's up to the end of one agent response. The source goes on as it was. The fork gets a fresh working folder: a
 * worktree on the same branch (code the source left uncommitted is not carried over), or an empty folder.
 */
@Injectable()
export class SessionForks {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(Transcripts) private readonly transcripts: Transcripts,
  ) {}

  async fork(sessionId: string, messageId: string): Promise<Session> {
    const source = this.sessions.get(sessionId);
    const kind = this.kinds.get(source.kind);
    if (!FORKABLE.includes(source.kind) || !kind?.create) {
      throw new ApiError(409, ErrorCode.InvalidState, `a ${source.kind} session cannot be forked`);
    }
    if (source.sdkSessionId === null || source.accountId === null) {
      throw new ApiError(409, ErrorCode.InvalidState, 'this session has no conversation to fork yet');
    }
    const configDir = this.accounts.configDir(this.accounts.get(source.accountId));
    const forked = await this.transcripts.fork(
      source.sdkSessionId,
      kind.workingDir(source),
      configDir,
      messageId,
      kind.serverLabel,
    );
    if (forked === null) throw new ApiError(404, ErrorCode.NotFound, 'no such response in this session');
    const common = {
      model: source.model,
      effort: source.effort,
      access_mode: source.accessMode,
      connection_ids: kind.view?.(source).connection_ids ?? [],
    };
    const created = await kind.create(
      source.kind === SessionKind.Repo
        ? { kind: SessionKind.Repo, repo_id: source.repoId, branch: source.branch, ...common }
        : { kind: SessionKind.Anonymous, ...common },
    );
    try {
      this.sessions.write(created.id, {
        sdkSessionId: forked,
        accountId: source.accountId,
        title: `${source.title} (fork)`,
      });
    } catch (error) {
      this.sessions.remove(created.id);
      throw error;
    }
    return this.sessions.view(this.sessions.get(created.id));
  }
}
