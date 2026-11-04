import { AlertStatus, CheckInterval, ScanStatus, ScanTrigger } from '@ops-console/shared';
import type { scans } from '../db/schema';
import { type AlertRow, parseJson, type ServiceRow } from './mappers';

type ScanRow = typeof scans.$inferSelect;

export const HOURS: Record<CheckInterval, number> = {
  [CheckInterval.Day]: 24,
  [CheckInterval.HalfDay]: 12,
  [CheckInterval.SixHours]: 6,
};

/** A Scan is overdue once this many Check intervals have passed since the last one that covered the Alert. */
const OVERDUE_INTERVALS = 2;

/** The Service a Scan may have read; `id` is unset for one the console has not stored yet. */
export type ScanTarget = { id: string | undefined; name: string; env: string; checkInterval: CheckInterval | null };

/**
 * Whether the Scan covers the Service: its env was read, and it is the one asked for, among the names asked for, or on
 * this schedule.
 */
export function scanReads(scan: ScanRow, target: ScanTarget, defaultInterval: CheckInterval): boolean {
  if (!parseJson<string[]>(scan.envs, []).includes(target.env)) return false;
  if (scan.serviceId) return target.id === scan.serviceId;
  const names = parseJson<string[] | null>(scan.services, null);
  if (names && !names.includes(target.name)) return false;
  if (scan.triggeredBy === ScanTrigger.Operator) return true;
  return (target.checkInterval ?? defaultInterval) === scan.windowSize;
}

/** An `ok` Scan that read the Alert's Service and, when it read only some status codes, the Alert's. */
function covers(scan: ScanRow, alert: AlertRow, service: ServiceRow, defaultInterval: CheckInterval): boolean {
  if (scan.status !== ScanStatus.Ok || !scan.finishedAt) return false;
  const codes = parseJson<number[]>(scan.statusCodes, []);
  if (codes.length > 0 && (alert.httpStatus === null || !codes.includes(alert.httpStatus))) return false;
  return scanReads(scan, service, defaultInterval);
}

/** `okScans` are the `ok` Scans, newest end first. */
export function freshnessOf(
  okScans: ScanRow[],
  alert: AlertRow,
  service: ServiceRow,
  defaultInterval: CheckInterval,
): { lastScannedAt: string | null; overdue: boolean } {
  const last = okScans.find((scan) => covers(scan, alert, service, defaultInterval));
  if (!last?.finishedAt) return { lastScannedAt: null, overdue: true };
  const interval = service.checkInterval ?? defaultInterval;
  const limit = OVERDUE_INTERVALS * HOURS[interval] * 3_600_000;
  return { lastScannedAt: last.finishedAt, overdue: Date.now() - Date.parse(last.finishedAt) > limit };
}

/** Resolved, and no Scan has read the Service without seeing the Alert since it was resolved. */
export function awaitingProdCheck(alert: AlertRow): boolean {
  if (alert.status !== AlertStatus.Resolved) return false;
  const seenHealthy = alert.clearedAt !== null && alert.clearedAt > (alert.resolvedAt ?? '');
  return !seenHealthy;
}
