import { type MonitorEnv, NO_ENV, SCAN_RANGES, ScanWindow } from '@ops-console/shared';
import { useState } from 'react';

const RANGE_KEY = 'ops-console-monitor-range';
const ENVS_KEY = 'ops-console-monitor-scan-envs';

function stored<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

const isRange = (value: unknown): value is ScanWindow => SCAN_RANGES.includes(value as ScanWindow);
const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === 'string');

/** How an env reads on screen. */
export const envLabel = (env: string) => (env === NO_ENV ? 'no env tag' : env);

export type ScanScope = {
  range: ScanWindow;
  pickRange: (range: ScanWindow) => void;
  /** The envs ticked: the operator's last pick, else the Connector's envs and the logs with no env tag. */
  envs: string[];
  toggleEnv: (env: string) => void;
};

/** The range and envs the Monitor lists Services for and scans; both kept across reloads. */
export function useScanScope(known: MonitorEnv[] | undefined): ScanScope {
  const [range, setRange] = useState<ScanWindow>(() => stored(RANGE_KEY, ScanWindow.Day, isRange));
  const [picked, setPicked] = useState<string[] | null>(() => stored<string[] | null>(ENVS_KEY, null, isNames));
  const envs = picked ?? (known ?? []).filter((env) => env.configured || env.name === NO_ENV).map((env) => env.name);
  return {
    range,
    pickRange: (next) => {
      setRange(next);
      localStorage.setItem(RANGE_KEY, JSON.stringify(next));
    },
    envs,
    toggleEnv: (env) => {
      const next = envs.includes(env) ? envs.filter((other) => other !== env) : [...envs, env];
      setPicked(next);
      localStorage.setItem(ENVS_KEY, JSON.stringify(next));
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
