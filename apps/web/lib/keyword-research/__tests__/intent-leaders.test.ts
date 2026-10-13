import { describe, expect, it } from "vitest";
import { leadersFrom, type OnCalendar } from "../intent-leaders";

/**
 * What owns a search. A planned row owns one only while it will still be
 * written; an article compares by its keyword row's results page whatever
 * that row's status is now; the calendar dates each planned row.
 */

const urls = (p: string) => Array.from({ length: 10 }, (_, i) => `https://${p}${i}.example/a`);
const everyPlanned: OnCalendar = () => true;

describe("leadersFrom", () => {
  it("leaves out a planned row the caller says will not be written, and keeps drafted and live rows whatever it says", () => {
    const leaders = leadersFrom({
      keywords: [
        { id: "p", term: "seo agencies", status: "planned", opportunity: { status: "rejected" } },
        { id: "d", term: "agency crm", status: "drafting", opportunity: null },
        { id: "l", term: "crm pricing", status: "shipped", opportunity: null },
        { id: "n", term: "crm news", status: "new", opportunity: null },
      ],
      articles: [],
      pages: [],
    }, () => false);
    expect(leaders.map((l) => [l.keywordId, l.stage])).toEqual([["d", "drafted"], ["l", "live"]]);
  });

  it("gives an article its keyword row's results page when the row is no longer in flight", () => {
    const leaders = leadersFrom({
      keywords: [{ id: "k", term: "mobil uygulama geliştirme şirketleri", status: "new", opportunity: { organicUrls: urls("k") } }],
      articles: [
        { id: "a1", keyword: "mobil uygulama geliştirme şirketleri", keyword_id: "k", status: "live" },
        { id: "a2", keyword: "kurumsal web tasarım", keyword_id: null, status: "review" },
      ],
      pages: [],
    }, everyPlanned);
    expect(leaders.find((l) => l.articleId === "a1")).toMatchObject({ kind: "article", stage: "live", organicUrls: urls("k") });
    expect(leaders.find((l) => l.articleId === "a2")).toMatchObject({ kind: "article", stage: "drafted", organicUrls: null });
  });

  it("dates a planned row by its earliest calendar entry", () => {
    const [leader] = leadersFrom({
      keywords: [{ id: "p", term: "seo agencies", status: "planned", opportunity: null }],
      articles: [],
      pages: [],
      entries: [
        { keyword_id: "p", scheduled_date: "2026-10-09" },
        { keyword_id: "p", scheduled_date: "2026-09-30" },
        { keyword_id: "x", scheduled_date: "2026-09-26" },
      ],
    }, everyPlanned);
    expect(leader).toMatchObject({ stage: "scheduled", date: "2026-09-30" });
  });
});
