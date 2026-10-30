import { Inject, Injectable } from '@nestjs/common';
import {
  ActionActor,
  type ActionKind,
  type ActionLogRow,
  ActionOutcome,
  type actionLogQuerySchema,
  type Page,
} from '@ops-console/shared';
import { and, desc, eq, lt, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { afterCursor, toPage } from '../common/pagination';
import { actionLog, nowIso } from '../db/schema';
import { type Emit, STORE, type Store, type Tx } from '../db/store';
import { redact } from './redact';

type ActionLogDbRow = typeof actionLog.$inferSelect;

const SEQ = sql<number>`"action_log"."rowid"`;

export type ActionToLog = {
  sessionId: string | null;
  kind: ActionKind;
  target: string;
  command: string;
  isProd: boolean;
};

export function toActionLogRow(row: ActionLogDbRow): ActionLogRow {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    kind: row.kind,
    session_id: row.sessionId,
    target: row.target,
    command: row.command,
    is_prod: row.isProd,
    outcome: row.outcome,
    error_message: row.errorMessage,
    finished_at: row.finishedAt,
  };
}

/** Rows are written, then closed with an outcome; nothing updates or deletes them otherwise (Behavior 16). */
@Injectable()
export class ActionLogService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  /** A `pending` row, written before the call runs. The command is redacted here, before it is stored. */
  start(action: ActionToLog): string {
    return this.store.write((tx, emit) => {
      const row = tx
        .insert(actionLog)
        .values({
          id: crypto.randomUUID(),
          actor: ActionActor.Agent,
          kind: action.kind,
          sessionId: action.sessionId,
          target: action.target,
          command: redact(action.command),
          isProd: action.isProd,
        })
        .returning()
        .get();
      emitLogged(emit, row);
      return row.id;
    });
  }

  /** Sets the outcome of a row still `pending`; a row already closed stays as it is. */
  finish(id: string, outcome: ActionOutcome, errorMessage: string | null = null): void {
    this.store.write((tx, emit) => this.close(tx, emit, id, outcome, errorMessage));
  }

  close(tx: Tx, emit: Emit, id: string, outcome: ActionOutcome, errorMessage: string | null): void {
    const row = tx
      .update(actionLog)
      .set({ outcome, errorMessage, finishedAt: nowIso })
      .where(and(eq(actionLog.id, id), eq(actionLog.outcome, ActionOutcome.Pending)))
      .returning()
      .get();
    if (row) emitLogged(emit, row);
  }

  list(query: z.infer<typeof actionLogQuerySchema>): Page<ActionLogRow> {
    const filters: (SQL | undefined)[] = [
      query.session_id === undefined ? undefined : eq(actionLog.sessionId, query.session_id),
      query.kind === undefined ? undefined : eq(actionLog.kind, query.kind),
      query.is_prod === undefined ? undefined : eq(actionLog.isProd, query.is_prod),
      query.outcome === undefined ? undefined : eq(actionLog.outcome, query.outcome),
    ];
    const after = afterCursor(query.cursor);
    if (after !== undefined) filters.push(lt(SEQ, Number(after)));
    // Insertion order: rows written in the same millisecond keep the order they were written in.
    const rows = this.store.db
      .select({ row: actionLog, seq: SEQ })
      .from(actionLog)
      .where(and(...filters))
      .orderBy(desc(SEQ))
      .limit(query.limit + 1)
      .all();
    const page = toPage(rows, query.limit, ({ seq }) => String(seq));
    return { data: page.data.map(({ row }) => toActionLogRow(row)), meta: page.meta };
  }
}

function emitLogged(emit: Emit, row: ActionLogDbRow): void {
  emit('action.logged', { id: row.id, kind: row.kind, target: row.target, is_prod: row.isProd, outcome: row.outcome });
}
