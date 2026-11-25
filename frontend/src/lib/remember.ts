import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { z } from 'zod';

const PREFIX = 'ops-console:';

/** A typed draft would write to the disk at every key; `typing` writes from `useStored` wait this long for the next one. */
const WRITE_DELAY_MS = 300;
const queued = new Map<string, () => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Writes every stored value still waiting. Reads call it first, and the page does when it hides or closes. */
export function flushStored(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const writes = [...queued.values()];
  queued.clear();
  for (const write of writes) write();
}

window.addEventListener('pagehide', flushStored);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushStored();
});

const watchers = new Set<() => void>();

/** A stored value, or `fallback` when there is none or it no longer parses (an older build, a hand edit). */
export function readStored<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  flushStored();
  return parseStored(rawStored(key), schema, fallback);
}

function rawStored(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function parseStored<T>(raw: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (raw === null) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/** Stores `value`; the fallback itself is not stored, so a cleared draft or a default choice leaves no key behind. */
export function writeStored<T>(key: string, value: T, fallback: T): void {
  queued.delete(key);
  try {
    const json = JSON.stringify(value);
    if (json === JSON.stringify(fallback)) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, json);
  } catch {
    // Storage full or blocked: the choice still holds until the page goes.
  }
  for (const watcher of watchers) watcher();
}

/**
 * A stored value read for display, redrawn when it is written. It does not flush a draft waiting to be typed out, so it
 * is safe in a list of rows; the write that follows the pause redraws it.
 */
export function useStoredValue<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  const subscribe = useCallback((notify: () => void) => {
    watchers.add(notify);
    return () => void watchers.delete(notify);
  }, []);
  const raw = useSyncExternalStore(subscribe, () => rawStored(key));
  // biome-ignore lint/correctness/useExhaustiveDependencies: the schema and fallback are fixed per key.
  return useMemo(() => parseStored(raw, schema, fallback), [raw]);
}

type Update<T> = T | ((now: T) => T);

/**
 * A choice the operator made on a page, kept in the browser until they change it: through page switches, reloads and
 * reopening the console. A key that changes (a draft per thread) reads the value stored under the new key.
 */
export function useStored<T>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
  /** `typing`: written after a pause in changes, for text typed key by key; any other value is written at once. */
  mode: 'now' | 'typing' = 'now',
): [T, (next: Update<T>) => void] {
  const [kept, setKept] = useState(() => ({ key, value: readStored(key, schema, fallback) }));
  const value = kept.key === key ? kept.value : readStored(key, schema, fallback);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the schema and fallback are fixed per key.
  const set = useCallback(
    (next: Update<T>) =>
      setKept((now) => {
        const current = now.key === key ? now.value : readStored(key, schema, fallback);
        const value = typeof next === 'function' ? (next as (now: T) => T)(current) : next;
        if (mode === 'typing') {
          queued.set(key, () => writeStored(key, value, fallback));
          if (timer) clearTimeout(timer);
          timer = setTimeout(flushStored, WRITE_DELAY_MS);
        } else writeStored(key, value, fallback);
        return { key, value };
      }),
    [key, mode],
  );
  return [value, set];
}

/**
 * The item a page shows, in the address so Back, Forward and a copied link open it. Setting several names at once
 * keeps them in one history entry; `null` drops a name. `replace` drops a pick that is gone without a Back step to it.
 */
export function useAddress<K extends string>(
  ...names: K[]
): [Record<K, string | null>, (next: Partial<Record<K, string | null>>, options?: { replace?: boolean }) => void] {
  const [params, setParams] = useSearchParams();
  // Router state, such as the page a link came from, belongs to the page and outlives a change of its item.
  const { state } = useLocation();
  const values = Object.fromEntries(names.map((name) => [name, params.get(name)])) as Record<K, string | null>;
  const set = useCallback(
    (next: Partial<Record<K, string | null>>, options?: { replace?: boolean }) =>
      setParams(
        (now) => {
          const out = new URLSearchParams(now);
          for (const [name, value] of Object.entries(next) as [K, string | null | undefined][]) {
            if (value === null || value === undefined) out.delete(name);
            else out.set(name, value);
          }
          return out;
        },
        { ...options, state },
      ),
    [setParams, state],
  );
  return [values, set];
}
