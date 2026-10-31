import { Inject, Injectable } from '@nestjs/common';
import {
  type AccessMode,
  type Effort,
  ErrorCode,
  type Model,
  type Page,
  SESSION_DEFAULTS,
  type Session,
  SessionKind,
  type SessionPatch,
  type SessionState,
  sessionDefaultsSchema,
  type sessionListQuerySchema,
} from '@ops-console/shared';
import { and, desc, eq, lt, or, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { ApiError, validationFailed } from '../common/errors';
import { afterCursor, toPage } from '../common/pagination';
import { sessions } from '../db/schema';
import { type Emit, STORE, type Store } from '../db/store';
import { SettingsRegistry } from '../settings/settings.registry';
import { SettingsService } from '../settings/settings.service';
import { RunRegistry } from './runs';
import { SessionKinds } from './session-kinds';

export const SESSION_DEFAULTS_KEY = 'session_defaults';
export const NEW_SESSION_TITLE = 'New session';

export type SessionRow = typeof sessions.$inferSelect;

export type NewSession = {
  kind: SessionKind;
  model?: Model;
  effort?: Effort;
  access_mode?: AccessMode;
  repoId?: string;
  branch?: string;
  prNumber?: number;
};

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    model: row.model,
    effort: row.effort,
    access_mode: row.accessMode,
    account_id: row.accountId,
    repo_id: row.repoId,
    branch: row.branch,
    pr_number: row.prNumber,
    connection_ids: null,
    state: row.state,
    last_message_preview: row.lastMessagePreview,
    created_at: row.createdAt,
    last_active_at: row.lastActiveAt,
  };
}

export function emitSessionUpdated(emit: Emit, row: SessionRow): void {
  emit('session.updated', {
    session_id: row.id,
    title: row.title,
    state: row.state,
    account_id: row.accountId,
    branch: row.branch,
  });
}

@Injectable()
export class SessionsService {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(RunRegistry) private readonly runs: RunRegistry,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
    @Inject(SettingsRegistry) registry: SettingsRegistry,
  ) {
    registry.register({ key: SESSION_DEFAULTS_KEY, schema: sessionDefaultsSchema, default: SESSION_DEFAULTS });
  }

  /** The creation step each kind's `POST /sessions` calls: settings the request leaves out come from the defaults. */
  create(input: NewSession): SessionRow {
    checkKindFields(input);
    const defaults = this.settings.get(SESSION_DEFAULTS_KEY, sessionDefaultsSchema);
    return this.store.write((tx) =>
      tx
        .insert(sessions)
        .values({
          id: crypto.randomUUID(),
          kind: input.kind,
          title: NEW_SESSION_TITLE,
          model: input.model ?? defaults.model,
          effort: input.effort ?? defaults.effort,
          accessMode: input.access_mode ?? defaults.access_mode,
          repoId: input.repoId ?? null,
          branch: input.branch ?? null,
          prNumber: input.prNumber ?? null,
        })
        .returning()
        .get(),
    );
  }

  get(id: string): SessionRow {
    const row = this.store.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such session');
    return row;
  }

  list(query: z.infer<typeof sessionListQuerySchema>): Page<Session> {
    const filters: (SQL | undefined)[] = [
      query.kind === undefined ? undefined : eq(sessions.kind, query.kind),
      query.q ? sql`instr(lower(${sessions.title}), lower(${query.q})) > 0` : undefined,
    ];
    const after = afterCursor(query.cursor);
    if (after !== undefined) {
      const [at = '', id = ''] = after.split('|');
      filters.push(or(lt(sessions.lastActiveAt, at), and(eq(sessions.lastActiveAt, at), lt(sessions.id, id))));
    }
    const rows = this.store.db
      .select()
      .from(sessions)
      .where(and(...filters))
      .orderBy(desc(sessions.lastActiveAt), desc(sessions.id))
      .limit(query.limit + 1)
      .all();
    return toPage(
      rows.map((row) => this.view(row)),
      query.limit,
      (row) => `${row.last_active_at}|${row.id}`,
    );
  }

  /** The Session with the fields its kind adds. */
  view(row: SessionRow): Session {
    return { ...toSession(row), ...this.kinds.get(row.kind)?.view?.(row) };
  }

  /** Model, effort and access mode apply from the Session's next run. */
  update(id: string, patch: SessionPatch): SessionRow {
    const row = this.get(id);
    const own = this.kinds.get(row.kind)?.patch;
    if (patch.connection_ids !== undefined && !own) throw validationFailed('invalid body: connection_ids');
    own?.(row, patch);
    const values = {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.model === undefined ? {} : { model: patch.model }),
      ...(patch.effort === undefined ? {} : { effort: patch.effort }),
      ...(patch.access_mode === undefined ? {} : { accessMode: patch.access_mode }),
    };
    return Object.keys(values).length === 0 ? row : this.write(id, values);
  }

  setState(id: string, state: SessionState): SessionRow {
    return this.write(id, { state });
  }

  /** Writes the row and sends `session.updated`. */
  write(id: string, values: Partial<Omit<SessionRow, 'id'>>): SessionRow {
    return this.store.write((tx, emit) => {
      const row = tx.update(sessions).set(values).where(eq(sessions.id, id)).returning().get();
      if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such session');
      emitSessionUpdated(emit, row);
      return row;
    });
  }

  /** The transcript stays where Claude Code keeps it; Action Log rows and Approvals lose their `session_id`. */
  remove(id: string): void {
    this.get(id);
    if (this.runs.get(id)) throw new ApiError(409, ErrorCode.SessionBusy, "the session's run is still going");
    this.store.write((tx) => tx.delete(sessions).where(eq(sessions.id, id)).run());
  }
}

/** A `repo` Session has a Repo and a branch; a `pr_review` Session a Repo and a pull request; others neither. */
function checkKindFields(input: NewSession): void {
  const hasRepo = input.repoId !== undefined;
  const hasBranch = input.branch !== undefined;
  const hasPr = input.prNumber !== undefined;
  const ok =
    input.kind === SessionKind.Repo
      ? hasRepo && hasBranch && !hasPr
      : input.kind === SessionKind.PrReview
        ? hasRepo && hasPr && !hasBranch
        : !hasRepo && !hasBranch && !hasPr;
  if (!ok) throw validationFailed(`invalid fields for a ${input.kind} session`);
}
