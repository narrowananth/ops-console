import type { Page } from '@ops-console/shared';

/**
 * Builds a page from rows fetched with `limit + 1`: the extra row only says another page exists.
 * The cursor is the sort key of the page's last row.
 */
export function toPage<T>(rows: T[], limit: number, sortKey: (row: T) => string): Page<T> {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  const next = rows.length > limit && last !== undefined ? Buffer.from(sortKey(last)).toString('base64url') : null;
  return { data, meta: { next_cursor: next } };
}

/** The sort key to fetch after, or `undefined` for the first page. */
export function afterCursor(cursor: string | undefined): string | undefined {
  return cursor === undefined ? undefined : Buffer.from(cursor, 'base64url').toString();
}
