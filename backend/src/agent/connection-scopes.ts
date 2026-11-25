import { Inject, Injectable } from '@nestjs/common';
import { AccessLevel, ConnectionEnv, ErrorCode, RunPurpose, type SessionPatch } from '@ops-console/shared';
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { connections, sessionConnections } from '../db/schema';
import { STORE, type Store } from '../db/store';
import type { SessionKindHandler } from './session-kinds';
import type { SessionRow } from './sessions.service';

/** How a run hands rows to the console, so it can draw the Result table. */
export const RESULT_BLOCK = `After each Connection answers, write one fenced block with the language ops-result holding one JSON object:
  {"connection": "<MCP server name>", "query": "<the query you ran>", "columns": ["..."], "rows": [["..."]], "total": <rows matched or null>, "ms": <milliseconds or null>}
  At most 50 rows. A Connection with no matching rows still gets a block with "rows": [].`;

/** What `step` parts and the agent's prompt show for a Connection: `mongo-prod (read-only)`. */
const labelOf = (row: { name: string; access: AccessLevel }): string =>
  `${row.name} (${row.access === AccessLevel.Write ? 'read-write' : 'read-only'})`;

/** The Connections a Session's runs may reach, kept in `session_connections`. */
@Injectable()
export class ConnectionScopes {
  constructor(@Inject(STORE) private readonly store: Store) {}

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
  denied(sessionId: string, emptyMeans: 'all' | 'none'): string[] {
    const named = new Set(this.ids(sessionId));
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
  note(sessionId: string): string | null {
    const named = new Set(this.ids(sessionId));
    const rows = this.store.db
      .select()
      .from(connections)
      .all()
      .filter((row) => named.has(row.id) && row.access !== AccessLevel.None);
    if (rows.length === 0) return null;
    const list = rows.map((row) => `${labelOf(row)}${row.env === ConnectionEnv.Prod ? ' PROD' : ''}`).join(', ');
    return `The operator gave this Session these Connections, each an MCP server you have: ${list}. Only read unless the operator asks for a change.

${RESULT_BLOCK}

You may also save fetched data as a file, such as a .csv or .json, in the output folder listed under Session folders.`;
  }
}

/**
 * The scope fields of a Session kind's handler. An empty scope reaches `emptyMeans` of the Connections with access:
 * every one in Dev tools, none in a coding Session. Only the operator's chat runs use the scope; a job keeps the
 * reach its purpose gives it (`mcpScope`).
 */
export function scopedConnections(
  scopes: ConnectionScopes,
  emptyMeans: 'all' | 'none',
): Pick<SessionKindHandler, 'view' | 'patch' | 'deniedServers' | 'serverLabel' | 'connectionsNote'> {
  return {
    view: (session) => ({ connection_ids: scopes.ids(session.id) }),
    patch: (session: SessionRow, patch: SessionPatch) => {
      if (patch.connection_ids === undefined) return;
      const ids = [...new Set(patch.connection_ids)];
      scopes.check(ids);
      scopes.set(session.id, ids);
    },
    deniedServers: (session, purpose) => (purpose === RunPurpose.Chat ? scopes.denied(session.id, emptyMeans) : []),
    serverLabel: (server) => scopes.label(server),
    // Dev tools has its own instructions for every Connection it has.
    ...(emptyMeans === 'none' ? { connectionsNote: (session: SessionRow) => scopes.note(session.id) } : {}),
  };
}
