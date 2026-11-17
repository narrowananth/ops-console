/**
 * `work` over `items`, at most `limit` at a time; the results keep the order of `items`. After one call throws, no
 * new item starts and the first error is thrown once the running ones end.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let at = next++; at < items.length && !failed; at = next++) {
        try {
          results[at] = await work(items[at] as T, at);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}
