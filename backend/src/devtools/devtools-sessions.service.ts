import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  AccessLevel,
  type CreateDevtoolsSession,
  createDevtoolsSessionSchema,
  ErrorCode,
  type Session,
  SessionKind,
  type SessionPatch,
} from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { SessionKinds } from '../agent/session-kinds';
import { type SessionRow, SessionsService } from '../agent/sessions.service';
import { DATA_DIR } from '../common/data-dir';
import { ApiError, parseInput } from '../common/errors';
import { connections, sessionConnections } from '../db/schema';
import { STORE, type Store } from '../db/store';

/** Sessions that query the operator's databases and queues through the Connections' MCP servers. */
@Injectable()
export class DevtoolsSessionsService {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(SessionKinds) kinds: SessionKinds,
  ) {
    kinds.register(SessionKind.Devtools, {
      workingDir: () => this.folder(),
      acceptsMessages: true,
      create: (body) => this.create(parseInput(createDevtoolsSessionSchema, body, 'body')),
      view: (session) => ({ connection_ids: this.scope(session.id) }),
      patch: (session, patch) => this.patch(session, patch),
      deniedServers: (session) => this.denied(session.id),
      serverLabel: (server) => this.label(server),
    });
  }

  create(input: CreateDevtoolsSession): Session {
    const ids = [...new Set(input.connection_ids)];
    this.checkScope(ids);
    const row = this.sessions.create({
      kind: SessionKind.Devtools,
      model: input.model,
      effort: input.effort,
      access_mode: input.access_mode,
    });
    this.setScope(row.id, ids);
    return this.sessions.view(row);
  }

  private patch(session: SessionRow, patch: SessionPatch): void {
    if (patch.connection_ids === undefined) return;
    const ids = [...new Set(patch.connection_ids)];
    this.checkScope(ids);
    this.setScope(session.id, ids);
  }

  /** The Connections the Session names, in the order they were chosen; empty means every one with access. */
  private scope(sessionId: string): string[] {
    return this.store.db
      .select({ id: sessionConnections.connectionId })
      .from(sessionConnections)
      .where(eq(sessionConnections.sessionId, sessionId))
      .all()
      .map((row) => row.id);
  }

  /** Every Connection outside the scope, so the next run cannot reach it. */
  private denied(sessionId: string): string[] {
    const named = new Set(this.scope(sessionId));
    return this.store.db
      .select()
      .from(connections)
      .all()
      .filter((row) => row.access === AccessLevel.None || (named.size > 0 && !named.has(row.id)))
      .map((row) => row.name);
  }

  /** What a step shows for the server: `mongo-prod (read-only)`. */
  private label(server: string): string | null {
    const row = this.store.db.select().from(connections).where(eq(connections.name, server)).get();
    if (!row) return null;
    return `${row.name} (${row.access === AccessLevel.Write ? 'read-write' : 'read-only'})`;
  }

  private checkScope(ids: string[]): void {
    for (const id of ids) {
      const row = this.store.db.select().from(connections).where(eq(connections.id, id)).get();
      if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Connection');
      if (row.access === AccessLevel.None) {
        throw new ApiError(409, ErrorCode.ConnectionNoAccess, `${row.name} has Access Level none`);
      }
    }
  }

  private setScope(sessionId: string, ids: string[]): void {
    this.store.write((tx) => {
      tx.delete(sessionConnections).where(eq(sessionConnections.sessionId, sessionId)).run();
      for (const connectionId of ids) tx.insert(sessionConnections).values({ sessionId, connectionId }).run();
    });
  }

  /** The agent has no Repo here; this folder holds what it writes while it answers. */
  private folder(): string {
    const dir = path.join(this.dataDir, 'devtools');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}
