import { Inject, Injectable } from '@nestjs/common';
import {
  ActionOutcome,
  type Approval,
  ApprovalKind,
  ApprovalStatus,
  type approvalListQuerySchema,
  ErrorCode,
  type Page,
} from '@ops-console/shared';
import { and, desc, eq, lt, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { ApiError } from '../common/errors';
import { afterCursor, toPage } from '../common/pagination';
import { actionLog, approvals, nowIso } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { ActionLogService } from './action-log.service';
import { redact } from './redact';

const SEQ = sql<number>`"approvals"."rowid"`;

export type Decision = ApprovalStatus.Approved | ApprovalStatus.Denied;

export type ApprovalRequest = {
  /** Null for an edit: the Action Log does not record edits. */
  actionLogId: string | null;
  sessionId: string;
  kind: ApprovalKind;
  summary: string;
  isProd: boolean;
};

@Injectable()
export class ApprovalsService {
  /** The agent's call waits on these until the operator decides. */
  private readonly waiting = new Map<string, (decision: Decision) => void>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
  ) {}

  /** Creates a `pending` Approval and resolves with the operator's decision. */
  request(request: ApprovalRequest): Promise<Decision> {
    const id = crypto.randomUUID();
    const summary = redact(request.summary);
    const decision = new Promise<Decision>((resolve) => this.waiting.set(id, resolve));
    this.store.write((tx, emit) => {
      tx.insert(approvals)
        .values({
          id,
          actionLogId: request.actionLogId,
          sessionId: request.sessionId,
          kind: request.kind,
          summary,
        })
        .run();
      emit('approval.requested', {
        approval_id: id,
        session_id: request.sessionId,
        kind: request.kind,
        summary,
        is_prod: request.isProd,
      });
    });
    return decision;
  }

  /** Approving lets the call run; denying sets its Action Log row `denied` and tells the agent no. */
  decide(id: string, decision: Decision): Approval {
    this.store.write((tx, emit) => {
      const row = tx.select().from(approvals).where(eq(approvals.id, id)).get();
      if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such approval');
      if (row.status !== ApprovalStatus.Pending) {
        throw new ApiError(409, ErrorCode.InvalidState, `the approval is already ${row.status}`);
      }
      tx.update(approvals).set({ status: decision, decidedAt: nowIso }).where(eq(approvals.id, id)).run();
      if (decision === ApprovalStatus.Denied && row.actionLogId !== null) {
        this.actionLog.close(tx, emit, row.actionLogId, ActionOutcome.Denied, null);
      }
      emit('approval.decided', { approval_id: id, decision });
    });
    this.waiting.get(id)?.(decision);
    this.waiting.delete(id);
    return this.get(id);
  }

  /** Start-up recovery: a run does not survive a restart, so nothing waits on a `pending` Approval any more. */
  expirePending(): void {
    this.store.write((tx, emit) => {
      const expired = tx
        .update(approvals)
        .set({ status: ApprovalStatus.Expired, decidedAt: nowIso })
        .where(eq(approvals.status, ApprovalStatus.Pending))
        .returning()
        .all();
      for (const row of expired) {
        if (row.actionLogId !== null)
          this.actionLog.close(tx, emit, row.actionLogId, ActionOutcome.Failed, 'interrupted');
        emit('approval.decided', { approval_id: row.id, decision: ApprovalStatus.Expired });
      }
    });
  }

  get(id: string): Approval {
    const approval = this.select(eq(approvals.id, id), 1)[0]?.approval;
    if (!approval) throw new ApiError(404, ErrorCode.NotFound, 'no such approval');
    return approval;
  }

  list(query: z.infer<typeof approvalListQuerySchema>): Page<Approval> {
    const filters: (SQL | undefined)[] = [query.status === undefined ? undefined : eq(approvals.status, query.status)];
    const after = afterCursor(query.cursor);
    if (after !== undefined) filters.push(lt(SEQ, Number(after)));
    const page = toPage(this.select(and(...filters), query.limit + 1), query.limit, ({ seq }) => String(seq));
    return { data: page.data.map(({ approval }) => approval), meta: page.meta };
  }

  /** Newest first, in insertion order. */
  private select(where: SQL | undefined, limit: number): { approval: Approval; seq: number }[] {
    return this.store.db
      .select({
        approval: approvals,
        seq: SEQ,
        target: actionLog.target,
        command: actionLog.command,
        isProd: actionLog.isProd,
      })
      .from(approvals)
      .leftJoin(actionLog, eq(approvals.actionLogId, actionLog.id))
      .where(where)
      .orderBy(desc(SEQ))
      .limit(limit)
      .all()
      .map(({ approval, seq, target, command, isProd }) => ({
        seq,
        approval: {
          id: approval.id,
          action_log_id: approval.actionLogId,
          session_id: approval.sessionId,
          kind: approval.kind,
          summary: approval.summary,
          status: approval.status,
          requested_at: approval.requestedAt,
          decided_at: approval.decidedAt,
          target,
          command,
          is_prod: isProd ?? false,
        },
      }));
  }
}
