import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AlertActor,
  AlertEventKind,
  AlertStatus,
  CONFIRM_WORDS,
  ConnectorId,
  ErrorCode,
  type Fix,
  type Review,
  type ReviewAlert,
  ReviewDecision,
  RunStatus,
} from '@ops-console/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { MessageInterceptors } from '../agent/message-interceptors';
import type { SessionRow } from '../agent/sessions.service';
import { ApiError } from '../common/errors';
import { ConnectorsService } from '../connectors/connectors.service';
import { alerts, fixes, reports, reviews } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { AlertsService } from './alerts.service';
import { FixesService } from './fixes.service';
import { type FixRow, type ReportRow, toFix, toReview } from './mappers';

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger('monitor');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(FixesService) private readonly fixes: FixesService,
    @Inject(MessageInterceptors) interceptors: MessageInterceptors,
  ) {
    interceptors.register((session, text) => this.confirmFromSession(session, text));
  }

  /** Confirm as bug or improvement, which starts the Fix, or dismiss. */
  review(alertId: string, body: ReviewAlert): { review: Review; fix: Fix | null } {
    const alert = this.alerts.row(alertId);
    this.alerts.requireStatus(alert, AlertStatus.Verified);
    const report = this.latestReady(alertId);
    if (body.decision === ReviewDecision.Dismissed) {
      const row = this.store.write((tx, emit) => {
        const created = tx
          .insert(reviews)
          .values({ id: crypto.randomUUID(), reportId: report.id, decision: ReviewDecision.Dismissed })
          .returning()
          .get();
        this.alerts.transition(tx, alertId, AlertStatus.Dismissed, AlertEventKind.Dismissed, AlertActor.Operator, {
          report_id: report.id,
        });
        emit('alert.reviewed', { alert_id: alertId, decision: ReviewDecision.Dismissed });
        return created;
      });
      return { review: toReview(row), fix: null };
    }
    this.connectors.require(ConnectorId.Jira);
    const created = this.store.write((tx, emit) => {
      const review = tx
        .insert(reviews)
        .values({ id: crypto.randomUUID(), reportId: report.id, decision: ReviewDecision.Confirmed, kind: body.kind })
        .returning()
        .get();
      const fix = tx.insert(fixes).values({ id: crypto.randomUUID(), reviewId: review.id }).returning().get();
      this.alerts.transition(tx, alertId, AlertStatus.Fixing, AlertEventKind.Confirmed, AlertActor.Operator, {
        report_id: report.id,
        kind: body.kind,
      });
      emit('alert.reviewed', { alert_id: alertId, decision: ReviewDecision.Confirmed });
      return { review, fix };
    });
    this.fixes.begin(created.fix.id);
    return { review: toReview(created.review), fix: toFix(created.fix as FixRow) };
  }

  /** Only a dismissal can be undone by the operator. */
  undo(alertId: string): void {
    const alert = this.alerts.row(alertId);
    this.alerts.requireStatus(alert, AlertStatus.Dismissed);
    const active = this.store.db
      .select({ review: reviews })
      .from(reviews)
      .innerJoin(reports, eq(reports.id, reviews.reportId))
      .where(
        and(eq(reports.alertId, alertId), isNull(reviews.undoneAt), eq(reviews.decision, ReviewDecision.Dismissed)),
      )
      .get();
    if (!active) throw new ApiError(409, ErrorCode.InvalidState, 'the Alert has no dismissal to undo');
    this.store.write((tx, emit) => {
      tx.update(reviews).set({ undoneAt: new Date().toISOString() }).where(eq(reviews.id, active.review.id)).run();
      this.alerts.transition(tx, alertId, AlertStatus.Verified, AlertEventKind.Undone, AlertActor.Operator);
      emit('alert.reviewed', { alert_id: alertId, decision: 'undone' });
    });
  }

  private latestReady(alertId: string): ReportRow {
    const report = this.store.db
      .select()
      .from(reports)
      .where(and(eq(reports.alertId, alertId), eq(reports.status, RunStatus.Ready)))
      .orderBy(desc(reports.version))
      .get();
    if (!report) throw new ApiError(409, ErrorCode.InvalidState, 'the Alert has no ready Report');
    return report;
  }

  /** Behavior 20: `go` and its kin, sent in a `verified` Alert's Session, confirm it as the Report recommends. */
  private confirmFromSession(session: SessionRow, text: string): boolean {
    if (session.alertId === null || !CONFIRM_WORDS.includes(text.trim().toLowerCase())) return false;
    const alert = this.store.db.select().from(alerts).where(eq(alerts.id, session.alertId)).get();
    if (alert?.status !== AlertStatus.Verified) return false;
    const kind = this.latestReady(alert.id).kind;
    if (kind === null) return false;
    try {
      this.review(alert.id, { decision: ReviewDecision.Confirmed, kind });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.logger.error(`confirm from session failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    return true;
  }
}
