/**
 * The order cron/generate serves workspaces in.
 *
 * Lives here rather than inline in the route because a Next.js route file may
 * only export its handlers, and because the invariant this encodes - that a
 * capped run rotates rather than repeatedly serving whoever the database
 * happened to return first - is not visible from reading the loop.
 */

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
