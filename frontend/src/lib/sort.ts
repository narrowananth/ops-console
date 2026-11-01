const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A copy sorted A→Z by `key`: case ignored, numbers in number order (`pg-2` before `pg-10`). */
export function ascending<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => collator.compare(key(a), key(b)));
}
