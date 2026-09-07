/**
 * Runs `worker` over `items` with at most `limit` in flight at once. Unlike
 * `Promise.all`, one item's rejection never stops the others -- each result is reported
 * as a settled outcome, mirroring `Promise.allSettled` semantics under a concurrency cap.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let index = 0;

  async function runNext(): Promise<void> {
    const i = index++;
    if (i >= items.length) return;
    try {
      const value = await worker(items[i], i);
      results[i] = { status: 'fulfilled', value };
    } catch (reason) {
      results[i] = { status: 'rejected', reason };
    }
    return runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
  return results;
}
