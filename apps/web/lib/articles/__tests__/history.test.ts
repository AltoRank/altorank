import { describe, it, expect } from "vitest";
import {
  countByFilter,
  filterHistory,
  formatMetric,
  historyDate,
  matchesTitle,
  sortByDateDesc,
  toHistoryRow,
  HISTORY_FILTERS,
  isHistoryFilter,
} from "@/lib/articles/history";
import type { Article } from "@/lib/types";

const rows = [
  { id: "1", title: "Warehouse Management Systems Explained", status: "live", date: "2026-09-01T10:00:00Z" },
  { id: "2", title: "AI Orchestration for Logistics", status: "review", date: "2026-09-03T10:00:00Z" },
  { id: "3", title: "Choosing a WMS vendor", status: "approved", date: "2026-08-20T10:00:00Z" },
  { id: "4", title: "Old post", status: "archived", date: null },
];

describe("matchesTitle", () => {
  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(matchesTitle("Warehouse Management", "  warehouse ")).toBe(true);
    expect(matchesTitle("Warehouse Management", "WMS")).toBe(false);
  });

  it("matches everything on an empty or blank query", () => {
    expect(matchesTitle("Anything", "")).toBe(true);
    expect(matchesTitle("Anything", "   ")).toBe(true);
  });
});

describe("filterHistory", () => {
  it("filters by title only, not by keyword or status text", () => {
    const out = filterHistory(rows, { query: "wms" });
    expect(out.map((r) => r.id)).toEqual(["3"]);
    // "live" is a status, not a title: nothing should match.
    expect(filterHistory(rows, { query: "live" })).toEqual([]);
  });

  it("combines the status chip with the query", () => {
    expect(filterHistory(rows, { status: "review" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterHistory(rows, { status: "review", query: "warehouse" })).toEqual([]);
    expect(filterHistory(rows, { status: "all" })).toHaveLength(4);
  });
});

describe("countByFilter", () => {
  it("counts every chip, including the ones with nothing behind them", () => {
    const counts = countByFilter(rows);
    expect(counts).toEqual({ all: 4, review: 1, approved: 1, scheduled: 0, live: 1, archived: 1 });
    // Every chip in the row has a count.
    for (const f of HISTORY_FILTERS) expect(counts[f.value]).toBeTypeOf("number");
  });

  it("ignores statuses that are not chips", () => {
    const counts = countByFilter([{ status: "drafting" }, { status: "error" }]);
    expect(counts.all).toBe(2);
    expect(counts.review + counts.approved + counts.scheduled + counts.live + counts.archived).toBe(0);
  });
});

describe("sortByDateDesc", () => {
  it("puts the newest first and undated rows last", () => {
    expect(sortByDateDesc(rows).map((r) => r.id)).toEqual(["2", "1", "3", "4"]);
  });

  it("does not mutate its input", () => {
    const copy = [...rows];
    sortByDateDesc(rows);
    expect(rows).toEqual(copy);
  });
});

describe("formatMetric", () => {
  it("renders a dash for null and a number for zero", () => {
    // Rule 5: an unmeasured value is not a zero. A measured zero is a zero.
    expect(formatMetric(null)).toBe("—");
    expect(formatMetric(0)).toBe("0");
    expect(formatMetric(12400)).toBe("12,400");
  });
});

describe("toHistoryRow", () => {
  const base = {
    id: "a1",
    workspace_id: "w1",
    title: "T",
    slug: "t",
    content: null,
    keyword: "k",
    status: "live",
    approved_by: null,
    approved_at: null,
    seo_score: 0,
    aeo_score: null,
    aeo_checks: null,
    volume: null,
    position: null,
    word_count: 0,
    cms: null,
    external_id: null,
    published_url: null,
    meta_description: null,
    ai_provider: null,
    generation_id: null,
    featured_image_url: null,
    replaces_article_id: null,
    scheduled_at: null,
    published_at: "2026-09-02T00:00:00Z",
    research: null,
    fact_checks: null,
    search_intent: null,
    fact_check_verdict: null,
    selection_reasons: null,
    selection_score: null,
    keyword_difficulty: null,
    seo_checks: null,
    link_checks: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
  } as unknown as Article;

  it("keeps null difficulty and volume as null rather than 0", () => {
    const row = toHistoryRow(base, false);
    expect(row.difficulty).toBeNull();
    expect(row.volume).toBeNull();
    expect(row.imageUrl).toBeNull();
  });

  it("dates a row by publish, then schedule, then last update", () => {
    expect(historyDate(base)).toBe("2026-09-02T00:00:00Z");
    expect(historyDate({ ...base, published_at: null, scheduled_at: "2026-09-10T00:00:00Z" })).toBe("2026-09-10T00:00:00Z");
    expect(historyDate({ ...base, published_at: null, scheduled_at: null })).toBe("2026-09-03T00:00:00Z");
  });

  it("recognises the chip values and nothing else", () => {
    expect(isHistoryFilter("review")).toBe(true);
    expect(isHistoryFilter("drafting")).toBe(false);
    expect(isHistoryFilter(null)).toBe(false);
  });
});
