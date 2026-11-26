import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  AccessLevel,
  ConnectionEnv,
  ConnectionType,
  ErrorCode,
  RunPurpose,
  type SessionPatch,
} from '@ops-console/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ApiError, validationFailed } from '../common/errors';
import { connections, repos, sessionConnections } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { connectionsNamedIn } from '../processes/prod-env';
import type { SessionKindHandler } from './session-kinds';
import type { SessionRow } from './sessions.service';

/** How a run hands rows to the console, so it can draw the Result table. */
export const RESULT_BLOCK = `After each Connection answers, write one fenced block with the language ops-result holding one JSON object:
  {"connection": "<MCP server name>", "query": "<the query you ran>", "columns": ["..."], "rows": [["..."]], "total": <rows matched or null>, "ms": <milliseconds or null>}
  At most 50 rows. A Connection with no matching rows still gets a block with "rows": [].`;

/** How a run puts several Results side by side, so the console can draw a Comparison. */
export const COMPARE_BLOCK = `When Results from two or more Connections describe the same thing, write one fenced block with the language ops-compare:
  {"key": "<field you matched on>", "value": "<its value>", "connections": ["<name>", "<name>"], "rows": [{"field": "<field>", "values": ["<value per connection, null when missing>"]}]}
  Match fields that mean the same thing even when their names differ. Put the fields that disagree first.`;

/** How an answer from Connections ends. */
export const CLOSING_LINE = `End with one line: "<rows> rows across <answered> of <queried> Connections", then one sentence on what differs, or that nothing was shared.`;

/** What `step` parts and the agent's prompt show for a Connection: `mongo-prod (read-only)`. */
const labelOf = (row: { name: string; access: AccessLevel }): string =>
  `${row.name} (${row.access === AccessLevel.Write ? 'read-write' : 'read-only'})`;

/** Tells the time to the reuse of matches; a test sets it. */
export const SCOPE_CLOCK = Symbol('SCOPE_CLOCK');

/** How long a Sessions list may reuse a PR Session's matched Connections before the Repo's folder is read again. */
const NAMED_TTL_MS = 5000;
const MAX_NAMED = 64;

/** A Connection the Repo's `.env` names. */
type Named = { id: string; prod: boolean };

/** The Connections a Session's runs may reach, kept in `session_connections`. */
@Injectable()
export class ConnectionScopes {
  /** Matches by Repo folder and the Connections they were made against, for the views of a Sessions list. */
  private readonly recent = new Map<string, { until: number; named: Named[] }>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Optional() @Inject(SCOPE_CLOCK) private readonly clock: () => number = Date.now,
  ) {}

  /** The Connections the Session names, in the order they were chosen. */
  ids(sessionId: string): string[] {
    return (
      this.store.db
        .select({ id: sessionConnections.connectionId })
        .from(sessionConnections)
        .where(eq(sessionConnections.sessionId, sessionId))
        // The primary key's index would list them by id.
        .orderBy(sql`rowid`)
        .all()
        .map((row) => row.id)
    );
  }

  /**
   * The Connections with Access Level `read` that the operator's own `.env` files in the Session's Repo's own folder
   * name (never its worktree, which a pull request's branch can edit). None for a Session with no Repo or no readable
   * file. `reuse` answers a match made less than 5 seconds ago for the same folder and Connections, so a list of
   * Sessions reads each folder once.
   */
  private match(repoId: string | null, reuse: boolean): Named[] {
    if (repoId === null) return [];
    const repo = this.store.db
      .select({ path: repos.path })
      .from(repos)
      .where(and(eq(repos.id, repoId), isNull(repos.removedAt)))
      .get();
    if (!repo) return [];
    const rows = this.store.db
      .select({ id: connections.id, access: connections.access, env: connections.env, config: connections.config })
      .from(connections)
      .all();
    const key = createHash('sha1')
      .update(JSON.stringify([repo.path, rows]))
      .digest('hex');
    const now = this.clock();
    const known = reuse ? this.recent.get(key) : undefined;
    if (known && known.until > now) return known.named;
    const named = connectionsNamedIn(repo.path, rows).map((row) => ({
      id: row.id,
      prod: row.env === ConnectionEnv.Prod,
    }));
    this.recent.delete(key);
    this.recent.set(key, { until: now + NAMED_TTL_MS, named });
    if (this.recent.size > MAX_NAMED) this.recent.delete(this.recent.keys().next().value ?? '');
    return named;
  }

  /** The ids a `repo` Session is ticked with when it is made: every Connection with read the Repo's `.env` names. */
  named(repoId: string | null): string[] {
    return this.match(repoId, false).map((row) => row.id);
  }

  /**
   * The Connections the Session's next run may reach: its scope, or, for a PR Session, which has no scope to edit, the
   * non-PROD ones its Repo's `.env` names, found now and stored nowhere. A PR Session reads text the operator did not
   * write, so it never gets a PROD Connection by itself. `reuse` is for a list's views, not for a run.
   */
  reach(session: SessionRow, reuse = false): string[] {
    if (session.prAction === null) return this.ids(session.id);
    return this.match(session.repoId, reuse)
      .filter((row) => !row.prod)
      .map((row) => row.id);
  }

  /** Throws `not_found` for an id no Connection has and `connection_no_access` for one with Access Level none. */
  check(ids: string[]): void {
    for (const id of ids) {
      const row = this.store.db.select().from(connections).where(eq(connections.id, id)).get();
      if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Connection');
      if (row.access === AccessLevel.None) {
        throw new ApiError(409, ErrorCode.ConnectionNoAccess, `${row.name} has Access Level none`);
      }
    }
  }

  set(sessionId: string, ids: string[]): void {
    this.store.write((tx) => {
      tx.delete(sessionConnections).where(eq(sessionConnections.sessionId, sessionId)).run();
      for (const connectionId of ids) tx.insert(sessionConnections).values({ sessionId, connectionId }).run();
    });
  }

  /** Every Connection outside the scope, so the next run cannot reach it; an empty scope leaves out `emptyMeans` of them. */
  denied(session: SessionRow, emptyMeans: 'all' | 'none'): string[] {
    const named = new Set(this.reach(session));
    return this.store.db
      .select()
      .from(connections)
      .all()
      .filter(
        (row) => row.access === AccessLevel.None || ((named.size > 0 || emptyMeans === 'none') && !named.has(row.id)),
      )
      .map((row) => row.name);
  }

  label(server: string): string | null {
    const row = this.store.db.select().from(connections).where(eq(connections.name, server)).get();
    return row ? labelOf(row) : null;
  }

  /** What the agent is told it can reach and how to hand back rows; null with an empty scope. */
  note(session: SessionRow): string | null {
    const named = new Set(this.reach(session));
    const rows = this.store.db
      .select()
      .from(connections)
      .all()
      .filter((row) => named.has(row.id) && row.access !== AccessLevel.None);
    if (rows.length === 0) return null;
    const list = rows.map((row) => `${labelOf(row)}${row.env === ConnectionEnv.Prod ? ' PROD' : ''}`).join(', ');
    const databases = rows
      .filter((row) => row.type === ConnectionType.Firebase)
      .map((row) => {
        const url = (JSON.parse(row.config) as { database_url?: string }).database_url;
        return url ? `${row.name}: ${url}` : `${row.name}: none set, so ask the operator for it`;
      });
    // `realtimedatabase_get_data` throws without `databaseUrl`, and answers a wrong one with `{"error": "404 Not Found"}`.
    const firebase =
      databases.length === 0
        ? ''
        : `\n\nFor a Firebase Connection's realtimedatabase_get_data, always pass databaseUrl, the Realtime Database address (${databases.join('; ')}).`;
    return `This Session has these Connections, each an MCP server you have: ${list}. Only read unless the operator asks for a change.${firebase}

${RESULT_BLOCK}
${COMPARE_BLOCK}
${CLOSING_LINE}

You may also save fetched data as a file, such as a .csv or .json, in the output folder listed under Session folders.`;
  }
}

/**
 * The scope fields of a Session kind's handler. An empty scope reaches `emptyMeans` of the Connections with access:
 * every one in Dev tools, none in a coding Session. Only the operator's chat runs use the scope; a job keeps the
 * reach its purpose gives it (`mcpScope`). A PR Session has no scope of its own: it reaches the Connections its Repo's
 * `.env` names (`ConnectionScopes.reach`) and cannot change that.
 */
export function scopedConnections(
  scopes: ConnectionScopes,
  emptyMeans: 'all' | 'none',
): Pick<SessionKindHandler, 'view' | 'patch' | 'deniedServers' | 'serverLabel' | 'connectionsNote'> {
  return {
    view: (session) => ({ connection_ids: scopes.reach(session, true) }),
    patch: (session: SessionRow, patch: SessionPatch) => {
      if (patch.connection_ids === undefined) return;
      // A PR Session's reach comes from its Repo's `.env`, not from the operator.
      if (session.prAction !== null) throw validationFailed('invalid body: connection_ids');
      const ids = [...new Set(patch.connection_ids)];
      scopes.check(ids);
      scopes.set(session.id, ids);
    },
    deniedServers: (session, purpose) => (purpose === RunPurpose.Chat ? scopes.denied(session, emptyMeans) : []),
    serverLabel: (server) => scopes.label(server),
    // Dev tools has its own instructions for every Connection it has.
    ...(emptyMeans === 'none' ? { connectionsNote: (session: SessionRow) => scopes.note(session) } : {}),
  };
}
