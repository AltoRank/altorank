import { describe, it, expect } from "vitest";
import { buildRankingRows } from "../rankings";
import type { RankingResult } from "../serp";

// This helper exists because the logic was duplicated byte for byte in
// app/actions/seo.ts and app/api/cron/serp/route.ts, and both copies wrote
// `position ?? 0` for a keyword that did not rank. These tests pin the two
// behaviours that were wrong.

const at = "2026-08-30T12:00:00.000Z";
const termToId = new Map([
  ["ai seo tools", "kw-1"],
  ["geo vs seo", "kw-2"],
]);

const r = (keyword: string, position: number | null, url: string | null = null): RankingResult =>
  ({ keyword, position, url }) as RankingResult;

describe("buildRankingRows", () => {
  it("keeps a real ranking", () => {
    const rows = buildRankingRows([r("ai seo tools", 7, "https://x.co/a")], termToId, at);
    expect(rows).toEqual([
      { keyword_id: "kw-1", position: 7, url: "https://x.co/a", checked_at: at },
    ]);
  });

  it("drops a keyword that did not rank, rather than storing position 0", () => {
    // The regression. `position: 0` is not a neutral placeholder: 0 sorts
    // ahead of 1, so a keyword ranking nowhere read as the best result in the
    // workspace and dragged every average toward zero.
    const rows = buildRankingRows([r("ai seo tools", null)], termToId, at);
    expect(rows).toEqual([]);
    expect(rows.some((row) => row.position === 0)).toBe(false);
  });

  it("keeps position 1 (the boundary the null check must not swallow)", () => {
    const rows = buildRankingRows([r("ai seo tools", 1)], termToId, at);
    expect(rows).toHaveLength(1);
    expect(rows[0].position).toBe(1);
  });

  it("drops results for keywords this workspace does not track", () => {
    const rows = buildRankingRows([r("someone elses keyword", 3)], termToId, at);
    expect(rows).toEqual([]);
  });

  it("keeps the ranked ones and drops the rest in a mixed batch", () => {
    const rows = buildRankingRows(
      [r("ai seo tools", 4), r("geo vs seo", null), r("untracked", 2)],
      termToId,
      at,
    );
    expect(rows.map((row) => row.keyword_id)).toEqual(["kw-1"]);
  });

  it("returns a null-free array, which is what next build enforces", () => {
    // `.filter(Boolean)` does not narrow (T | null)[] to T[]; the type
    // predicate does. This broke the build outright before the fix.
    const rows = buildRankingRows([r("ai seo tools", null), r("geo vs seo", 9)], termToId, at);
    expect(rows.every((row) => row !== null)).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("stamps every row with one checked_at, so a batch shares a timestamp", () => {
    const rows = buildRankingRows([r("ai seo tools", 2), r("geo vs seo", 5)], termToId, at);
    expect(new Set(rows.map((row) => row.checked_at)).size).toBe(1);
  });

  it("handles an empty result set", () => {
    expect(buildRankingRows([], termToId, at)).toEqual([]);
  });
});
