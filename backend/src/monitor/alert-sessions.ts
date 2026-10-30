import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, SessionKind } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { SessionsService } from '../agent/sessions.service';
import { ApiError } from '../common/errors';
import { repos, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GIT, Git } from '../repos/git';
import type { AlertRow, ServiceRow } from './mappers';

/** The `repo` Session an Alert's Verification and Fix run in: one per Alert, made on first use. */
@Injectable()
export class AlertSessions {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  /** Refuses a Service with no Repo. */
  repoOf(service: ServiceRow) {
    const repo = service.repoId
      ? this.store.db.select().from(repos).where(eq(repos.id, service.repoId)).get()
      : undefined;
    if (!repo) throw new ApiError(409, ErrorCode.ServiceUnlinked, `${service.name} has no Repo`);
    return repo;
  }

  async ensure(alert: AlertRow, service: ServiceRow): Promise<string> {
    const existing = this.store.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.alertId, alert.id))
      .get();
    if (existing) return existing.id;
    const repo = this.repoOf(service);
    const branch = (await this.git.currentBranch(repo.path)) ?? repo.defaultBranch;
    const created = this.sessions.create({ kind: SessionKind.Repo, repoId: repo.id, branch });
    this.sessions.write(created.id, { alertId: alert.id, title: alert.title.slice(0, 80) });
    return created.id;
  }
}
