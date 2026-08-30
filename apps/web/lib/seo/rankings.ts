import type { RankingResult } from "@/lib/seo/serp";

/** A row ready for insert into `keyword_rankings`. */
export type RankingRow = {
  keyword_id: string;
  position: number;
  url: string | null;
  checked_at: string;
};

/**
 * Turn SERP results into rows for `keyword_rankings`.
 *
 * This existed twice, byte for byte, in app/actions/seo.ts and
 * app/api/cron/serp/route.ts, and carried the same two bugs in both copies.
 *
 * The first was a fabricated measurement. Both copies wrote `position ?? 0`
 * because `keyword_rankings.position` is `integer not null`, so there was no
 * way to record "checked, did not rank". Storing 0 is not a neutral
 * placeholder: 0 sorts ahead of 1, so a keyword that ranked nowhere read as
 * the single best result in the workspace, and every average over the column
 * was dragged toward zero by terms that had never ranked at all. Rows with no
 * position are now dropped. Absence of a row is the honest encoding of
 * absence, and it needs no migration.
 *
 * The second was a type error that broke `next build` outright:
 * `.filter(Boolean)` does not narrow `(T | null)[]` to `T[]`, so the array
 * handed to `.insert()` still admitted null. A type predicate does narrow it.
 *
 * If a future change needs to distinguish "not ranking" from "not checked",
 * that is a nullable column plus a migration, decided once, here.
 */
export function buildRankingRows(
  rankings: RankingResult[],
  termToId: Map<string, string>,
  checkedAt: string = new Date().toISOString(),
): RankingRow[] {
  return rankings
    .map((r) => {
      const keywordId = termToId.get(r.keyword);
      if (!keywordId || r.position == null) return null;
      return {
        keyword_id: keywordId,
        position: r.position,
        url: r.url,
        checked_at: checkedAt,
      };
    })
    .filter((row): row is RankingRow => row !== null);
}
