import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, SessionKind } from '@ops-console/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { SessionsService } from '../agent/sessions.service';
import { ApiError } from '../common/errors';
import { repos, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { cloneUrl, GIT, Git } from '../repos/git';
import { AnonymousSessionsService } from '../workspace/anonymous-sessions.service';
import type { AlertRow, ServiceRow } from './mappers';

type RepoRow = typeof repos.$inferSelect;

/** Where an Alert's code is: the Service's local Repo, else a clone of its Git host URL. */
export type CodeSource = { kind: 'repo'; repo: RepoRow; name: string } | { kind: 'url'; url: string; name: string };

/**
 * The Session an Alert's Verification and Fix run in: one per Alert, made on first use. A `repo` Session in the
 * Service's Repo when it has one; otherwise an `anonymous` Session holding a clone of the Service's `repo_url`.
 */
@Injectable()
export class AlertSessions {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AnonymousSessionsService) private readonly anonymous: AnonymousSessionsService,
  ) {}

  /** Refuses a Service with neither a Repo nor a Git host URL. */
  sourceOf(service: ServiceRow): CodeSource {
    const repo = service.repoId
      ? this.store.db
          .select()
          .from(repos)
          .where(and(eq(repos.id, service.repoId), isNull(repos.removedAt)))
          .get()
      : undefined;
    if (repo) return { kind: 'repo', repo, name: repo.name };
    if (service.repoUrl) return { kind: 'url', url: cloneUrl(service.repoUrl), name: service.repoUrl };
    throw new ApiError(
      409,
      ErrorCode.ServiceUnlinked,
      `${service.name} has no Repo: pick one, or give the Git URL of its code`,
    );
  }

  /** The Alert's Session if it has one. */
  existing(alertId: string) {
    return this.store.db.select().from(sessions).where(eq(sessions.alertId, alertId)).get();
  }

  /** The Alert's Session, made on first use; `onStep` hears about a clone before it starts. */
  async ensure(alert: AlertRow, service: ServiceRow, onStep: (text: string) => void = () => {}): Promise<string> {
    const found = this.existing(alert.id);
    if (found) return found.id;
    const source = this.sourceOf(service);
    const title = alert.title.slice(0, 80);
    if (source.kind === 'repo') {
      const branch = (await this.git.currentBranch(source.repo.path)) ?? source.repo.defaultBranch;
      const created = this.sessions.create({ kind: SessionKind.Repo, repoId: source.repo.id, branch });
      this.sessions.write(created.id, { alertId: alert.id, title });
      return created.id;
    }
    const created = this.anonymous.create({ title });
    this.sessions.write(created.id, { alertId: alert.id });
    onStep(`$ git clone ${source.url.replace(/\/\/[^@/]+@/, '//')}`);
    try {
      await this.anonymous.clone(created.id, source.url);
    } catch (error) {
      // The next try clones again into a fresh Session.
      this.sessions.remove(created.id);
      throw error;
    }
    return created.id;
  }
}
