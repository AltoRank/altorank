// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------
//
// A first look's model and provider calls used to go one batch at a time:
// six buyer-test batches of 15 seconds each, back to back, on a production
// signup (2026-10-09). This runs them side by side, at most `limit` at once,
// and hands the results back in the order the items were given, so a caller
// that merges them merges them exactly as the sequential loop did.

/** Map `items` through `fn`, at most `limit` in flight, results in input order. A throw rejects the whole call. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
