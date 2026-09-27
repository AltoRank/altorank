// ---------------------------------------------------------------------------
// Every row of a read, not the first page of it
// ---------------------------------------------------------------------------
//
// PostgREST caps every response at `max_rows` (1000 on the hosted platform and
// in supabase/config.toml) and says nothing when it does: the rows come back,
// the error is null, and the list is simply short. A read that has to see
// everything - the duplicate-intent rule comparing a candidate against every
// page, article and keyword a site already holds - compared against the first
// thousand, and a duplicate of the rest got through with nothing in the log
// (round-4 review, seeded with 1,100 site pages: 1,000 came back).
//
// So such reads page through, a page of PAGE rows at a time, ordered on a
// unique column (or rows can repeat or go missing between pages), until a
// page comes back short. PAGE is the cap itself: supabase/config.toml and the
// hosted default are both 1,000. A server set to a lower cap would make the
// first page short and end the read early, so the cap is not lowered here
// without lowering PAGE with it.
//
// The result has the shape of a PostgREST response, so a call site keeps its
// `if (res.error)` and its `res.data`; a failed page fails the whole read.

const PAGE = 1000;

export type ReadAllResult<T> = { data: T[] | null; error: { message: string } | null };

export async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<ReadAllResult<T>> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { data: null, error };
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < PAGE) return { data: out, error: null };
  }
}
