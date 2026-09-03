/**
 * The order cron/generate serves workspaces in.
 *
 * Lives here rather than inline in the route because a Next.js route file may
 * only export its handlers, and because the invariant this encodes - that a
 * capped run rotates rather than repeatedly serving whoever the database
 * happened to return first - is not visible from reading the loop.
 */

/**
 * Seconds one draft takes, measured rather than guessed.
 *
 * From the 10:01 UTC production run on 2026-09-03: the step ran 10:02:01 to
 * 10:05:28, 206 seconds, and wrote two articles (two more workspaces were
 * skipped at their weekly limit, which costs a query each). Call it 103
 * seconds a draft: research, the model call, the fact check and the scoring
 * passes.
 */
export const OBSERVED_SECONDS_PER_ARTICLE = 103;

/** The route's `maxDuration`. Restated here so the cap can be checked against it. */
export const RUN_BUDGET_SECONDS = 300;

/**
 * Articles one invocation will write before stopping, across all workspaces.
 *
 * Two, because three does not fit. The number was three on the reasoning that
 * a draft is "research, a model call, a fact check and eleven scoring passes,
 * so three is what fits in five minutes with room to spare" - a guess, and
 * the first real measurement put a draft at 103 seconds. Three of those is
 * about 310 seconds against a 300-second function.
 *
 * That run did not time out, which is the part worth understanding: only two
 * of four workspaces were eligible, the other two having hit their weekly
 * limits. So the overrun was latent rather than absent, and it would have
 * arrived the moment anyone raised a pace - which migration 041 has just made
 * possible up to 25 a week.
 *
 * What is left over is not lost; the next run is six hours later. At the point
 * where demand routinely exceeds this, the answer is a queue, not a bigger
 * number.
 */
export const MAX_ARTICLES_PER_RUN = 2;

/** What the ordering needs from a workspace row. Anything with an id will do. */
export interface Queueable {
  id: string;
}

/**
 * Least-recently-written first, never-written before that.
 *
 * `cron/generate` stops after MAX_ARTICLES_PER_RUN articles. Its workspace
 * query has no ORDER BY, so Postgres returns a stable order, and a stable
 * order under a cap is a queue nobody advances in: the same workspaces sit at
 * the front of all four daily runs and the rest wait for them to exhaust their
 * weekly limits. Sorting by last draft turns the cap into a rotation.
 *
 * A workspace absent from `lastWritten` has produced nothing in the window and
 * sorts first - it has gone without longest, so it has the strongest claim.
 *
 * Timestamps are compared as strings, which is correct for the ISO-8601 UTC
 * that Postgres returns and avoids parsing dates only to sort them.
 */
export function orderByStaleness<T extends Queueable>(
  workspaces: readonly T[],
  lastWritten: ReadonlyMap<string, string>,
): T[] {
  return [...workspaces].sort((a, b) => {
    const x = lastWritten.get(a.id);
    const y = lastWritten.get(b.id);
    if (x === y) return 0;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    return x.localeCompare(y);
  });
}

/**
 * The most recent autonomous draft per workspace, from rows ordered newest
 * first. The first row seen for a workspace is therefore its latest, and later
 * rows for the same workspace are older and ignored.
 */
export function latestPerWorkspace(
  rows: readonly { workspace_id: string; created_at: string }[],
): Map<string, string> {
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (!latest.has(row.workspace_id)) latest.set(row.workspace_id, row.created_at);
  }
  return latest;
}
