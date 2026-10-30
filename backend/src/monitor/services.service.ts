import { Inject, Injectable } from '@nestjs/common';
import {
  AlertStatus,
  ErrorCode,
  type patchRouteSchema,
  type patchServiceSchema,
  type RouteView,
  type Service,
} from '@ops-console/shared';
import { and, asc, desc, eq, inArray, max, notInArray } from 'drizzle-orm';
import type { z } from 'zod';
import { ApiError } from '../common/errors';
import { alerts, repos, routes, scanRouteResults, scans, services } from '../db/schema';
import { STORE, type Store } from '../db/store';
import type { RouteRow, ServiceRow } from './mappers';

/** Scans a Route's trend covers. */
const TREND = 7;

@Injectable()
export class ServicesService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  list(env?: string): Service[] {
    return this.store.db
      .select()
      .from(services)
      .where(env === undefined ? undefined : eq(services.env, env))
      .orderBy(asc(services.name), asc(services.env))
      .all()
      .map((row) => this.view(row));
  }

  patch(id: string, body: z.infer<typeof patchServiceSchema>): Service {
    this.row(id);
    if (body.repo_id) {
      const repo = this.store.db.select({ id: repos.id }).from(repos).where(eq(repos.id, body.repo_id)).get();
      if (!repo) throw new ApiError(404, ErrorCode.NotFound, 'no such Repo');
    }
    const values: Partial<typeof services.$inferInsert> = {
      ...(body.repo_id === undefined ? {} : { repoId: body.repo_id }),
      ...(body.check_interval === undefined ? {} : { checkInterval: body.check_interval }),
    };
    if (Object.keys(values).length > 0) {
      this.store.write((tx) => tx.update(services).set(values).where(eq(services.id, id)).run());
    }
    return this.view(this.row(id));
  }

  patchRoute(id: string, body: z.infer<typeof patchRouteSchema>): RouteView {
    const found = this.store.db.select().from(routes).where(eq(routes.id, id)).get();
    if (!found) throw new ApiError(404, ErrorCode.NotFound, 'no such Route');
    const values: Partial<typeof routes.$inferInsert> = {
      ...(body.ignored === undefined ? {} : { ignored: body.ignored }),
      ...(body.note === undefined ? {} : { note: body.note?.trim() || null }),
    };
    if (Object.keys(values).length > 0) {
      this.store.write((tx) => tx.update(routes).set(values).where(eq(routes.id, id)).run());
    }
    return this.routeView(this.store.db.select().from(routes).where(eq(routes.id, id)).get() as RouteRow);
  }

  private row(id: string): ServiceRow {
    const row = this.store.db.select().from(services).where(eq(services.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Service');
    return row;
  }

  private view(row: ServiceRow): Service {
    const routeRows = this.store.db
      .select()
      .from(routes)
      .where(eq(routes.serviceId, row.id))
      .orderBy(asc(routes.path), asc(routes.method))
      .all();
    const routeIds = routeRows.map((route) => route.id);
    const open =
      routeIds.length === 0
        ? []
        : this.store.db
            .select({ id: alerts.id })
            .from(alerts)
            .where(
              and(
                inArray(alerts.routeId, routeIds),
                notInArray(alerts.status, [AlertStatus.Resolved, AlertStatus.Dismissed]),
              ),
            )
            .all();
    const last = this.store.db
      .select({ at: max(scans.finishedAt) })
      .from(scanRouteResults)
      .innerJoin(scans, eq(scans.id, scanRouteResults.scanId))
      .innerJoin(routes, eq(routes.id, scanRouteResults.routeId))
      .where(eq(routes.serviceId, row.id))
      .get()?.at;
    return {
      id: row.id,
      name: row.name,
      env: row.env,
      repo_id: row.repoId,
      check_interval: row.checkInterval,
      created_at: row.createdAt,
      routes: routeRows.map((route) => this.routeView(route)),
      open_alert_count: open.length,
      last_scan_at: last ?? null,
    };
  }

  private routeView(route: RouteRow): RouteView {
    const recent = this.store.db
      .select()
      .from(scanRouteResults)
      .where(eq(scanRouteResults.routeId, route.id))
      .orderBy(desc(scanRouteResults.scannedAt))
      .limit(TREND)
      .all();
    return {
      id: route.id,
      method: route.method,
      path: route.path,
      ignored: route.ignored,
      note: route.note,
      state: recent[0]?.state ?? null,
      trend: recent.map((result) => result.errorCount).reverse(),
    };
  }
}
