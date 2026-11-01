import { type Alert, AlertStatus, SCAN_RANGES, ScanWindow } from '@ops-console/shared';
import { useState } from 'react';

const RANGE_KEY = 'ops-console-monitor-range';
const CODES_KEY = 'ops-console-monitor-status-codes';

function stored<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

const isRange = (value: unknown): value is ScanWindow => SCAN_RANGES.includes(value as ScanWindow);
const isCodes = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((code) => Number.isInteger(code) && code >= 400);

export type ScanScope = {
  range: ScanWindow;
  pickRange: (range: ScanWindow) => void;
  /** The HTTP status codes picked; empty for every code from 400 up. */
  codes: number[];
  pickCodes: (codes: number[]) => void;
};

/**
 * Whether the Monitor lists an Alert. One with no HTTP status code came from before Scans read codes: it shows only
 * while the operator is working on it. Any other shows when its code is in the pick, or the pick is every code.
 */
export function shown(alert: Alert, codes: number[] = []): boolean {
  if (alert.http_status === null) return alert.status !== AlertStatus.Open;
  return codes.length === 0 || codes.includes(alert.http_status);
}

/** The range and HTTP status codes the Monitor lists Services for and scans, in every env; kept across reloads. */
export function useScanScope(): ScanScope {
  const [range, setRange] = useState<ScanWindow>(() => stored(RANGE_KEY, ScanWindow.Day, isRange));
  const [codes, setCodes] = useState<number[]>(() => stored<number[]>(CODES_KEY, [], isCodes));
  return {
    range,
    pickRange: (next) => {
      setRange(next);
      localStorage.setItem(RANGE_KEY, JSON.stringify(next));
    },
    codes,
    pickCodes: (next) => {
      const sorted = [...new Set(next)].sort((a, b) => a - b);
      setCodes(sorted);
      localStorage.setItem(CODES_KEY, JSON.stringify(sorted));
    },
  };
}

/** `3m ago`, `2h ago`, `4d ago`. */
export function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}
