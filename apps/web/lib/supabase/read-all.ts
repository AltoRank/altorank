// ---------------------------------------------------------------------------
// Every row of a PostgREST read, not the first thousand
// ---------------------------------------------------------------------------
//
// PostgREST answers a select with at most `max_rows` rows (1,000 in
// supabase/config.toml and on Supabase's hosted default) and says nothing when
// it stops there: the rows come back, the error is null, and the list is
// simply short. Two kinds of read got that wrong:
//
// - A read that is summed - a month of clicks, a month of GA4 pageviews -
//   reported whichever thousand rows the planner found first as if they were
//   the whole window. That shipped in the client report twice, for Search
//   Console and for GA4.
// - A read that has to see everything - the duplicate-intent rule comparing a
//   candidate against every page, article and keyword a site already holds -
//   compared against the first thousand, and a duplicate of the rest got
//   through with nothing in the log (round-4 review, seeded with 1,100 site
//   pages: 1,000 came back).
//
// So those reads go through `readAllPages`, which asks for one page at a time
// until it has them all. When it has them all is decided by the row count
// PostgREST reports on the first page, not by a page coming back short: a
// short page only means "the last page" when the page size and the server's
// cap agree, and if the hosted cap were ever set below the page size, the
// short-page rule would stop after one page without a word. With the count, a
// lower cap only means more pages. A first page that reports no count is an
// error, not a cue to fall back on the short-page rule: it means the caller
// did not pass `count` into its select, and that read would be exactly as
// capped as the one this replaced.
//
// Paging is by offset over an order the caller makes unique (lib/gsc/read.ts
// orders by metric_date, then id; the rest order on id). That never skips or
// repeats a row while the rows being read are not being rewritten. The nightly
// sync does rewrite a day (it deletes the day's rows and inserts them again
// with new ids), and a read that pages across that moment can still see part
// of the day twice or not at all: PostgREST gives each page its own
// transaction, so no read made of several requests is a snapshot. The sync
// runs at night, a page is milliseconds, and a dashboard is read again on the
// next load. The cap, by contrast, cut every large read short, every time.

/**
 * The page asked for: PostgREST's `max_rows`. A server cap below it costs
 * pages, not rows, because the count decides when the read is done.
 */
export const PAGE_SIZE = 1000;

/** What one page returns: the shape of a supabase-js select, narrowed to what this reads. */
export type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
};

/**
 * Build one page: apply `.range(from, to)` to the caller's query, over a
 * unique order, and pass `count` through to `.select(columns, { count })`.
 * `count` is "exact" on the first page only; the total does not need asking
 * twice.
 */
export type PageQuery<T> = (from: number, to: number, count: "exact" | undefined) => PromiseLike<PageResult<T>>;

/**
 * Every row the query matches, a page at a time. Throws on a database error,
 * naming `what`: a partial read summed or compared as if whole is the bug this
 * exists to end, so there is no "return what we got". Throws too when the
 * first page reports no count (see above).
 */
export async function readAllPages<T>(what: string, page: PageQuery<T>): Promise<T[]> {
  const out: T[] = [];
  let total = 0;
  for (;;) {
    const from = out.length;
    const { data, error, count } = await page(from, from + PAGE_SIZE - 1, from === 0 ? "exact" : undefined);
    if (error) throw new Error(`${what} failed: ${error.message}`);
    if (from === 0) {
      if (typeof count !== "number") {
        throw new Error(
          `${what}: the first page reported no row count, so there is no telling whether it was the whole read. ` +
            `Pass the third argument into .select(columns, { count }).`,
        );
      }
      total = count;
    }
    const batch = data ?? [];
    for (const row of batch) out.push(row);
    // An empty page ends it whatever the count said: rows deleted since the
    // count was taken are not coming back, and waiting for them would never end.
    if (batch.length === 0 || out.length >= total) return out;
  }
}
