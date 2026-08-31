import type { RankingResult } from "@/lib/seo/serp";

/** A row ready for insert into `keyword_rankings`. */
export type RankingRow = {
  keyword_id: string;
  /** NULL means "checked, not found in the results". Never 0. */
  position: number | null;
  url: string | null;
  checked_at: string;
};

/**
 * Turn SERP results into rows for `keyword_rankings`.
 *
 * This existed twice, byte for byte, in app/actions/seo.ts and
 * app/api/cron/serp/route.ts, and both copies wrote `position ?? 0` for a
 * keyword that did not rank. Rank 0 sorts ahead of rank 1, so a keyword
 * ranking nowhere read as the best result in the workspace and dragged every
 * average over the column toward zero. Migration 026 found 14 such rows and
 * every one of them was a keyword the site did not rank for.
 *
 * Two fixes were written for this independently, in two sessions, on the same
 * day. The first dropped the row. This is the other one, and it is better:
 * migration 026 makes the column nullable so NULL can mean "checked, not
 * found". Dropping the row loses the fact that a check happened at all, and
 * for a young domain, which is most of this product's users, "we looked and
 * you are still not there" is the whole point of a rank tracker. You cannot
 * plot an absence you never recorded.
 *
 * So: rows with no position are KEPT with position NULL. Rows whose keyword is
 * not in this workspace are dropped, because they are not ours to record.
 *
 * The type predicate on the filter is load-bearing and unrelated:
 * `.filter(Boolean)` does not narrow `(T | null)[]` to `T[]`, which broke
 * `next build` outright.
 *
 * Requires migration 026. Against an unmigrated database the column is still
 * NOT NULL and these inserts will fail loudly, which is the correct failure:
 * better a visible error than silently recording a rank of zero again.
 */
export function buildRankingRows(
  rankings: RankingResult[],
  termToId: Map<string, string>,
  checkedAt: string = new Date().toISOString(),
): RankingRow[] {
  return rankings
    .map((r) => {
      const keywordId = termToId.get(r.keyword);
      if (!keywordId) return null;
      return {
        keyword_id: keywordId,
        position: r.position ?? null,
        url: r.url,
        checked_at: checkedAt,
      };
    })
    .filter((row): row is RankingRow => row !== null);
}
