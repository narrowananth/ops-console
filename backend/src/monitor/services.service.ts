import { Inject, Injectable } from '@nestjs/common';
import {
  AlertStatus,
  ErrorCode,
  type patchRouteSchema,
  type patchServiceSchema,
  type RouteState,
  type RouteView,
  type Service,
} from '@ops-console/shared';
import { and, asc, count, desc, eq, isNull, lte, max, notInArray, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { ApiError } from '../common/errors';
import { alerts, repos, routes, scanRouteResults, scans, services } from '../db/schema';
import { STORE, type Store } from '../db/store';
import type { RouteRow, ServiceRow } from './mappers';

/** Scans a Route's trend covers. */
const TREND = 7;

/** A Route with its newest results, newest first: its state is the newest one's, its trend the counts oldest first. */
function routeView(route: RouteRow, recent: { state: RouteState; errorCount: number }[]): RouteView {
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

@Injectable()
export class ServicesService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  list(env?: string): Service[] {
    const rows = this.store.db
      .select()
      .from(services)
      .where(env === undefined ? undefined : eq(services.env, env))
      .orderBy(asc(services.name), asc(services.env))
      .all();
    return this.views(rows, env === undefined ? undefined : eq(services.env, env));
  }

  patch(id: string, body: z.infer<typeof patchServiceSchema>): Service {
    this.row(id);
    if (body.repo_id) {
      const repo = this.store.db
        .select({ id: repos.id })
        .from(repos)
        .where(and(eq(repos.id, body.repo_id), isNull(repos.removedAt)))
        .get();
      if (!repo) throw new ApiError(404, ErrorCode.NotFound, 'no such Repo');
    }
    const values: Partial<typeof services.$inferInsert> = {
      ...(body.repo_id === undefined ? {} : { repoId: body.repo_id }),
      ...(body.repo_url === undefined ? {} : { repoUrl: body.repo_url }),
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
    return this.routeViewOf(this.store.db.select().from(routes).where(eq(routes.id, id)).get() as RouteRow);
  }

  get(id: string): Service {
    return this.view(this.row(id));
  }

  private view(row: ServiceRow): Service {
    return this.views([row], eq(services.id, row.id))[0] as Service;
  }

  private row(id: string): ServiceRow {
    const row = this.store.db.select().from(services).where(eq(services.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Service');
    return row;
  }

  /**
   * The Services of `scope` (every one when undefined) as the API shows them, from a few grouped reads of their Routes,
   * open Alerts, Scans and Route results, not a few reads per Service.
   */
  private views(rows: ServiceRow[], scope: SQL | undefined): Service[] {
    const db = this.store.db;
    const routeRows = db
      .select({ route: routes })
      .from(routes)
      .innerJoin(services, eq(services.id, routes.serviceId))
      .where(scope)
      .orderBy(asc(routes.path), asc(routes.method))
      .all()
      .map((found) => found.route);
    const openCounts = new Map(
      db
        .select({ serviceId: routes.serviceId, open: count() })
        .from(alerts)
        .innerJoin(routes, eq(routes.id, alerts.routeId))
        .innerJoin(services, eq(services.id, routes.serviceId))
        .where(and(scope, notInArray(alerts.status, [AlertStatus.Resolved, AlertStatus.Dismissed])))
        .groupBy(routes.serviceId)
        .all()
        .map((found) => [found.serviceId, found.open]),
    );
    const lastScans = new Map(
      db
        .select({ serviceId: routes.serviceId, at: max(scans.finishedAt) })
        .from(scanRouteResults)
        .innerJoin(scans, eq(scans.id, scanRouteResults.scanId))
        .innerJoin(routes, eq(routes.id, scanRouteResults.routeId))
        .innerJoin(services, eq(services.id, routes.serviceId))
        .where(scope)
        .groupBy(routes.serviceId)
        .all()
        .map((found) => [found.serviceId, found.at]),
    );
    // The newest results of each Route: a window over the Route's results, newest first.
    const ranked = db
      .select({
        routeId: scanRouteResults.routeId,
        state: scanRouteResults.state,
        errorCount: scanRouteResults.errorCount,
        rank: sql<number>`row_number() over (partition by ${scanRouteResults.routeId} order by ${scanRouteResults.scannedAt} desc)`.as(
          'rank',
        ),
      })
      .from(scanRouteResults)
      .innerJoin(routes, eq(routes.id, scanRouteResults.routeId))
      .innerJoin(services, eq(services.id, routes.serviceId))
      .where(scope)
      .as('ranked');
    const recent = new Map<string, { state: RouteState; errorCount: number }[]>();
    for (const result of db.select().from(ranked).where(lte(ranked.rank, TREND)).orderBy(asc(ranked.rank)).all()) {
      const list = recent.get(result.routeId) ?? [];
      list.push({ state: result.state, errorCount: result.errorCount });
      recent.set(result.routeId, list);
    }
    const byService = new Map<string, RouteRow[]>();
    for (const route of routeRows) byService.set(route.serviceId, [...(byService.get(route.serviceId) ?? []), route]);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      env: row.env,
      repo_id: row.repoId,
      repo_url: row.repoUrl,
      check_interval: row.checkInterval,
      created_at: row.createdAt,
      // Logs with no request hang on a blank Route; it is no Route to the operator.
      routes: (byService.get(row.id) ?? [])
        .filter((route) => route.method !== '')
        .map((route) => routeView(route, recent.get(route.id) ?? [])),
      open_alert_count: openCounts.get(row.id) ?? 0,
      last_scan_at: lastScans.get(row.id) ?? null,
    }));
  }

  private routeViewOf(route: RouteRow): RouteView {
    const recent = this.store.db
      .select()
      .from(scanRouteResults)
      .where(eq(scanRouteResults.routeId, route.id))
      .orderBy(desc(scanRouteResults.scannedAt))
      .limit(TREND)
      .all();
    return routeView(route, recent);
  }
}
