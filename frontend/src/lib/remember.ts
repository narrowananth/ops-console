import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { z } from 'zod';

const PREFIX = 'ops-console:';

/** A stored value, or `fallback` when there is none or it no longer parses (an older build, a hand edit). */
export function readStored<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/** Stores `value`; the fallback itself is not stored, so a cleared draft or a default choice leaves no key behind. */
export function writeStored<T>(key: string, value: T, fallback: T): void {
  try {
    const json = JSON.stringify(value);
    if (json === JSON.stringify(fallback)) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, json);
  } catch {
    // Storage full or blocked: the choice still holds until the page goes.
  }
}

type Update<T> = T | ((now: T) => T);

/**
 * A choice the operator made on a page, kept in the browser until they change it: through page switches, reloads and
 * reopening the console. A key that changes (a draft per thread) reads the value stored under the new key.
 */
export function useStored<T>(key: string, schema: z.ZodType<T>, fallback: T): [T, (next: Update<T>) => void] {
  const [kept, setKept] = useState(() => ({ key, value: readStored(key, schema, fallback) }));
  const value = kept.key === key ? kept.value : readStored(key, schema, fallback);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the schema and fallback are fixed per key.
  const set = useCallback(
    (next: Update<T>) =>
      setKept((now) => {
        const current = now.key === key ? now.value : readStored(key, schema, fallback);
        const value = typeof next === 'function' ? (next as (now: T) => T)(current) : next;
        writeStored(key, value, fallback);
        return { key, value };
      }),
    [key],
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
  const values = Object.fromEntries(names.map((name) => [name, params.get(name)])) as Record<K, string | null>;
  const set = useCallback(
    (next: Partial<Record<K, string | null>>, options?: { replace?: boolean }) =>
      setParams((now) => {
        const out = new URLSearchParams(now);
        for (const [name, value] of Object.entries(next) as [K, string | null | undefined][]) {
          if (value === null || value === undefined) out.delete(name);
          else out.set(name, value);
        }
        return out;
      }, options),
    [setParams],
  );
  return [values, set];
}
