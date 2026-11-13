import { Inject, Injectable } from '@nestjs/common';
import {
  type AccessMode,
  type Effort,
  ErrorCode,
  type Model,
  type Page,
  RunOutcome,
  SESSION_DEFAULTS,
  type Session,
  SessionKind,
  type SessionPatch,
  SessionState,
  sessionDefaultsSchema,
  type sessionListQuerySchema,
} from '@ops-console/shared';
import { and, desc, eq, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, validationFailed } from '../common/errors';
import { afterCursor, toPage } from '../common/pagination';
import { repos, sessions } from '../db/schema';
import { type Emit, STORE, type Store } from '../db/store';
import { PlaybooksService } from '../playbooks/playbooks.service';
import { SettingsRegistry } from '../settings/settings.registry';
import { SettingsService } from '../settings/settings.service';
import { RunRegistry } from './runs';
import { SessionKinds } from './session-kinds';

export const SESSION_DEFAULTS_KEY = 'session_defaults';
export const NEW_SESSION_TITLE = 'New session';

/** Runs that ended unfinished stay in the Running tray until the operator dismisses them. */
export const KEPT_OUTCOMES = [
  RunOutcome.Stopped,
  RunOutcome.Paused,
  RunOutcome.Failed,
  RunOutcome.RateLimited,
  RunOutcome.SignedOut,
  RunOutcome.Interrupted,
];

export type SessionRow = typeof sessions.$inferSelect;

export type NewSession = {
  kind: SessionKind;
  model?: Model;
  effort?: Effort;
  access_mode?: AccessMode;
  repoId?: string;
  branch?: string;
  prNumber?: number;
  /** The Session whose agent started this one, and the `spawn_sessions` call that did. */
  spawnedBy?: { sessionId: string; callId: string };
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
    pull_request:
      row.openedPrNumber !== null && row.openedPrUrl !== null && row.openedPrBranch === row.branch
        ? { number: row.openedPrNumber, url: row.openedPrUrl }
        : null,
    connection_ids: null,
    alert_id: row.alertId,
    extra_repo_ids: extraRepoIds(row),
    state: row.state,
    last_message_preview: row.lastMessagePreview,
    last_error: null,
    created_at: row.createdAt,
    last_active_at: row.lastActiveAt,
    playbook: null,
    queued_message: row.queuedText,
    spawned_by: null,
    spawned: [],
  };
}

/** The other Repos the operator opened to the Session's agent. */
export function extraRepoIds(row: SessionRow): string[] {
  if (row.extraRepoIds === null) return [];
  try {
    const ids: unknown = JSON.parse(row.extraRepoIds);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
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
  /** Why each Session's last run failed; a restart or the next run clears it. */
  private readonly failures = new Map<string, string>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(RunRegistry) private readonly runs: RunRegistry,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
    @Inject(PlaybooksService) private readonly playbooks: PlaybooksService,
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
          spawnedBySessionId: input.spawnedBy?.sessionId ?? null,
          spawnCallId: input.spawnedBy?.callId ?? null,
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
      // Kept with a removed Repo: they come back when the operator imports it again.
      sql`(${sessions.repoId} is null or ${sessions.repoId} not in (select ${repos.id} from ${repos} where ${repos.removedAt} is not null))`,
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

  /** The Sessions the Running tray lists: a run going now, or one that ended unfinished and was not dismissed. */
  runRows(): SessionRow[] {
    return this.store.db
      .select()
      .from(sessions)
      .where(
        and(
          or(
            inArray(sessions.state, [SessionState.Working, SessionState.WaitingInput, SessionState.WaitingApproval]),
            inArray(sessions.runOutcome, KEPT_OUTCOMES),
          ),
          sql`(${sessions.repoId} is null or ${sessions.repoId} not in (select ${repos.id} from ${repos} where ${repos.removedAt} is not null))`,
        ),
      )
      .orderBy(desc(sessions.lastActiveAt), desc(sessions.id))
      .all();
  }

  /** Takes an ended run out of the tray. Refused with `session_busy` while the Session's run is going. */
  dismissRun(id: string): void {
    this.get(id);
    if (this.runs.get(id)) throw new ApiError(409, ErrorCode.SessionBusy, "the session's run is still going");
    this.write(id, { runOutcome: null });
  }

  /** Takes every ended run out of the tray; runs going stay. Returns how many left. */
  dismissEndedRuns(): number {
    return this.store.write((tx, emit) => {
      const rows = tx
        .update(sessions)
        .set({ runOutcome: null })
        .where(
          and(
            inArray(sessions.runOutcome, KEPT_OUTCOMES),
            sql`${sessions.state} not in ('working', 'waiting_input', 'waiting_approval')`,
          ),
        )
        .returning()
        .all();
      for (const row of rows) emitSessionUpdated(emit, row);
      return rows.length;
    });
  }

  /** Remembers why a Session's run failed, or forgets it with `null`. */
  setFailure(id: string, message: string | null): void {
    if (message === null) this.failures.delete(id);
    else this.failures.set(id, message);
  }

  /** The Session with the fields its kind adds. */
  view(row: SessionRow): Session {
    return {
      ...toSession(row),
      last_error: this.failures.get(row.id) ?? null,
      playbook: this.playbooks.forSession(row).playbook,
      ...this.spawnLinks(row),
      ...this.kinds.get(row.kind)?.view?.(row),
    };
  }

  /** The Session that started this one and the Sessions this one started, with where each stands. */
  private spawnLinks(row: SessionRow): Pick<Session, 'spawned_by' | 'spawned'> {
    const parent =
      row.spawnedBySessionId === null
        ? null
        : this.store.db.select().from(sessions).where(eq(sessions.id, row.spawnedBySessionId)).get();
    const children = this.store.db
      .select({ row: sessions, repoName: repos.name })
      .from(sessions)
      .leftJoin(repos, eq(repos.id, sessions.repoId))
      .where(eq(sessions.spawnedBySessionId, row.id))
      .orderBy(sessions.createdAt)
      .all();
    return {
      spawned_by: parent ? { id: parent.id, title: parent.title } : null,
      spawned: children.map(({ row: child, repoName }) => ({
        id: child.id,
        title: child.title,
        call_id: child.spawnCallId,
        repo_name: repoName,
        branch: child.branch,
        state: child.state,
        run_outcome: child.runOutcome,
        pull_request: toSession(child).pull_request,
      })),
    };
  }

  /** Model, effort and access mode apply from the Session's next run. */
  update(id: string, patch: SessionPatch): SessionRow {
    const row = this.get(id);
    const own = this.kinds.get(row.kind)?.patch;
    if (patch.connection_ids !== undefined && !own) throw validationFailed('invalid body: connection_ids');
    own?.(row, patch);
    const values = {
      ...(patch.extra_repo_ids === undefined
        ? {}
        : { extraRepoIds: this.checkedExtraRepos(row, patch.extra_repo_ids) }),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.model === undefined ? {} : { model: patch.model }),
      ...(patch.effort === undefined ? {} : { effort: patch.effort }),
      ...(patch.access_mode === undefined ? {} : { accessMode: patch.access_mode }),
    };
    if (Object.keys(values).length > 0) return this.write(id, values);
    // A change only the kind stores, such as a devtools scope, still tells every open page.
    if (own) this.store.write((_tx, emit) => emitSessionUpdated(emit, row));
    return row;
  }

  /** The ids as the column stores them: each an imported Repo other than the Session's own, once, in the order given. */
  private checkedExtraRepos(row: SessionRow, ids: string[]): string | null {
    const known = new Set(
      this.store.db
        .select({ id: repos.id })
        .from(repos)
        .where(isNull(repos.removedAt))
        .all()
        .map((repo) => repo.id),
    );
    const missing = ids.find((id) => !known.has(id));
    if (missing !== undefined) throw new ApiError(404, ErrorCode.NotFound, 'no such repo');
    const kept = [...new Set(ids)].filter((id) => id !== row.repoId);
    return kept.length === 0 ? null : JSON.stringify(kept);
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
    const row = this.get(id);
    if (this.runs.get(id)) throw new ApiError(409, ErrorCode.SessionBusy, "the session's run is still going");
    this.store.write((tx) => tx.delete(sessions).where(eq(sessions.id, id)).run());
    void this.kinds
      .get(row.kind)
      ?.removed?.(row)
      .catch(() => {});
  }
}

/**
 * A `repo` Session has a Repo and a branch; a `pr_review` Session a Repo and a pull request; an `anonymous` Session
 * may have a branch; others none of these.
 */
function checkKindFields(input: NewSession): void {
  const hasRepo = input.repoId !== undefined;
  const hasBranch = input.branch !== undefined;
  const hasPr = input.prNumber !== undefined;
  const ok =
    input.kind === SessionKind.Repo
      ? hasRepo && hasBranch && !hasPr
      : input.kind === SessionKind.PrReview
        ? hasRepo && hasPr && !hasBranch
        : input.kind === SessionKind.Anonymous
          ? !hasRepo && !hasPr
          : !hasRepo && !hasBranch && !hasPr;
  if (!ok) throw validationFailed(`invalid fields for a ${input.kind} session`);
}
