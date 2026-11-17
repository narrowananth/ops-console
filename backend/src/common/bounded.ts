/** Resolves when `work` settles or after `ms`, whichever comes first; the work is not cancelled. Never rejects. */
export async function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
