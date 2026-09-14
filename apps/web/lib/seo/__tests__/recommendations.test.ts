import { describe, it, expect } from "vitest";
import { assessKeywordQuality, normalizeTarget, recommendKeywords } from "../recommendations";
import type { SupabaseClient } from "@supabase/supabase-js";

const terms = (...t: string[]) => new Set(t.map((x) => x.toLowerCase()));

type Row = Record<string, unknown>;
const body = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

/** Apply the production read filters and projections to mutable local fixtures. */
function coverageClient(articles: Row[], position?: number): SupabaseClient {
  const tables: Record<string, Row[]> = {
    keywords: [{ id: "topic", workspace_id: "site", term: "newsletter tools", intent: "commercial", status: "new", volume: 100, difficulty: null }],
    workspaces: [{ id: "site", domain: "example.test", topical_profile: null, business_profile: null, dr: null }],
    articles,
    keyword_rankings: position === undefined ? [] : [{ keyword_id: "topic", position, checked_at: "2026-09-14" }],
    analytics_metrics: [],
  };
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let columns: string[] = [];
      const result = () => ({ data: tables[table].filter(row => filters.every(filter => filter(row))).map(row => Object.fromEntries(columns.map(column => [column, row[column]]))), error: null });
      const query = {
        select(value: string) { columns = value.split(",").map(column => column.trim()); return query; },
        eq(column: string, value: unknown) { filters.push(row => row[column] === value); return query; },
        in(column: string, values: unknown[]) { filters.push(row => values.includes(row[column])); return query; },
        not(column: string, _operator: string, value: unknown) { filters.push(row => (row[column] ?? null) !== value); return query; },
        gte() { return query; },
        order() { return query; },
        async single() { return { ...result(), data: result().data[0] ?? null }; },
        then(resolve: (value: ReturnType<typeof result>) => unknown) { return Promise.resolve(resolve(result())); },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

describe("recommendKeywords — failed attempts are not topic coverage", () => {
  const article = (patch: Row = {}): Row => ({ id: "existing", workspace_id: "site", keyword: "newsletter tools", status: "review", content: body("Compare the sending limits before choosing a newsletter tool."), ...patch });

  it("keeps a withheld topic writable, then recognises only its successful retry", async () => {
    const articles = [article({ id: "withheld", status: "error", content: null, word_count: 1200 })];
    const db = coverageClient(articles);
    expect((await recommendKeywords(db, "site"))[0]).toMatchObject({ action: "write", existingArticleId: null });

    articles.unshift(article({ id: "successful-retry" }));
    // Failed attempts can remain for diagnostics, even after the saved article.
    articles.push(article({ id: "later-error", status: "error", content: { type: "doc", content: [] } }));
    expect(await recommendKeywords(db, "site")).toEqual([
      expect.objectContaining({ action: "refresh", existingArticleId: "successful-retry" }),
    ]);
  });

  it.each(["draft", "review", "approved", "scheduled", "live", "drafting"])("preserves substantive %s content as a refresh target", async status => {
    // Short authored content still counts. No word-count threshold is imposed.
    const db = coverageClient([article({ status, keyword: "tools for newsletters", content: body("Compare sending limits.") })]);
    expect((await recommendKeywords(db, "site"))[0]).toMatchObject({ action: "refresh", existingArticleId: "existing" });
  });

  it("preserves an approved article after a failed publication", async () => {
    const db = coverageClient([article({ status: "error", approved_by: "editor" })]);
    expect((await recommendKeywords(db, "site"))[0]).toMatchObject({ action: "refresh", existingArticleId: "existing" });
  });

  it.each([
    { status: "draft", content: null },
    { status: "drafting", content: { type: "doc", content: [] } },
    { status: "review", content: body(" \u00a0\n ") },
    { status: "draft", content: { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Newsletter tools" }] }] } },
    { status: "draft", content: { type: "doc", content: [{ type: "image", attrs: { alt: "Newsletter tools", src: "https://example.test/image.png" } }] } },
    { status: "error", approved_by: null },
    { status: "archived" },
  ])("ignores empty, failed or archived content: %j", async patch => {
    const db = coverageClient([article(patch)]);
    expect((await recommendKeywords(db, "site"))[0]).toMatchObject({ action: "write", existingArticleId: null });
  });

  it("does not borrow coverage from another workspace", async () => {
    const db = coverageClient([article({ workspace_id: "other-site" })]);
    expect((await recommendKeywords(db, "site"))[0]).toMatchObject({ action: "write", existingArticleId: null });
  });

  it("preserves ranking decisions while refusing a phantom refresh target", async () => {
    const failed = article({ status: "error", content: null });
    expect((await recommendKeywords(coverageClient([failed], 15), "site"))[0]).toMatchObject({ action: "write", existingArticleId: null });
    expect((await recommendKeywords(coverageClient([article({ status: "live" })], 15), "site"))[0]).toMatchObject({ action: "refresh", existingArticleId: "existing" });
    expect((await recommendKeywords(coverageClient([failed], 5), "site"))[0]).toMatchObject({ action: "skip", existingArticleId: null });
  });
});

describe("assessKeywordQuality — provider noise", () => {
  it("flags company names carried over from competitor rankings", () => {
    expect(assessKeywordQuality("worlder inc", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("acme ltd.", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("venture builders", terms()).quality).toBe("ok");
    expect(assessKeywordQuality("inc", terms()).quality).toBe("ok");
  });
  it("accepts an ordinary multi-word query", () => {
    expect(assessKeywordQuality("seo for agencies", terms()).quality).toBe("ok");
  });

  it("rejects a term containing a single-letter word", () => {
    // "s eo" arrives from the keyword API with real-looking volume.
    const r = assessKeywordQuality("s eo", terms());
    expect(r.quality).toBe("suspect");
    expect(r.note).toContain("single-letter");
  });

  it("keeps a one-letter word that is a word", () => {
    // Refused on 2026-09-07 for the "a"; the commonest how-to shape there is.
    expect(assessKeywordQuality("how to start a paid newsletter", terms()).quality).toBe("ok");
    expect(assessKeywordQuality("how to add a signup form", terms()).quality).toBe("ok");
    expect(assessKeywordQuality("come aprire una newsletter a pagamento", terms()).quality).toBe("ok");
    // A lone consonant is still a split word.
    expect(assessKeywordQuality("newsletter s oftware", terms()).quality).toBe("suspect");
  });

  it("still refuses a phrase cut on 'start' or 'add'", () => {
    expect(assessKeywordQuality("ai started", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("newsletter add", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai stop", terms()).quality).toBe("suspect");
  });

  it("rejects a split spelling of another tracked keyword", () => {
    const r = assessKeywordQuality("zap ier", terms("zapier", "zap ier"));
    expect(r.quality).toBe("suspect");
    expect(r.note).toContain("zapier");
  });

  it("rejects characters a searcher would not type", () => {
    expect(assessKeywordQuality("_zapier", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("all & one", terms()).quality).toBe("suspect");
  });

  it("rejects a leading negation or function word", () => {
    // Wrote "No Keywords Showing? What It Means and How to Fix It" for altorank.co.
    expect(assessKeywordQuality("no keywords", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("and seo", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("keyword research", terms()).quality).toBe("ok");
  });

  it("rejects a term cut mid-phrase", () => {
    // The lully.ai queue led with "ai can" (110/mo) on 2026-09-02.
    expect(assessKeywordQuality("ai can", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai in", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai in retail", terms()).quality).toBe("ok");
  });

  it("rejects two words joined by and", () => {
    expect(assessKeywordQuality("reviews and seo", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai and logistics", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("search and rescue training", terms()).quality).toBe("ok");
  });

  it("rejects a term containing a word that carries no topic", () => {
    // supalabs.co's first keyword set, 2026-09-02.
    for (const t of ["ai stop", "ai makes", "ai are you", "not ai", "its ai", "ai more", "all the answers are correct"]) {
      expect(assessKeywordQuality(t, terms()).quality, t).toBe("suspect");
    }
    // Question words and comparatives are real queries, not fragments.
    for (const t of ["what is logistics", "best warehouse software", "ai native operations"]) {
      expect(assessKeywordQuality(t, terms()).quality, t).toBe("ok");
    }
  });

  it("rejects a preposition plus a bare generic noun", () => {
    expect(assessKeywordQuality("ai in company", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai for business", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai in logistics", terms()).quality).toBe("ok");
    expect(assessKeywordQuality("warehouse management system", terms()).quality).toBe("ok");
  });

  it("rejects a term that repeats a word", () => {
    expect(assessKeywordQuality("seo and seo", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("seo what is seo", terms()).quality).toBe("suspect");
  });

  it("rejects a trailing two-letter fragment", () => {
    // "seo co" is a truncation of "seo company" and reads as a typo in a title.
    expect(assessKeywordQuality("seo co", terms()).quality).toBe("suspect");
  });

  it("rejects anything too short to be a query", () => {
    expect(assessKeywordQuality("ai", terms()).quality).toBe("suspect");
  });

  it("keeps a legitimate hyphenated or apostrophised term", () => {
    expect(assessKeywordQuality("e-commerce platform", terms()).quality).toBe("ok");
    expect(assessKeywordQuality("google's algorithm", terms()).quality).toBe("ok");
  });
});

describe("normalizeTarget — cannibalisation", () => {
  it("collapses word order and connecting words to one target", () => {
    // Caught live: the cron wrote "agency seo" then "agency for seo".
    const a = normalizeTarget("agency seo");
    expect(normalizeTarget("agency for seo")).toBe(a);
    expect(normalizeTarget("seo for agencies")).toBe(a);
  });

  it("folds plurals", () => {
    expect(normalizeTarget("seo agencies")).toBe(normalizeTarget("seo agency"));
    expect(normalizeTarget("keyword tools")).toBe(normalizeTarget("keyword tool"));
  });

  it("keeps genuinely different queries apart", () => {
    expect(normalizeTarget("seo automation")).not.toBe(normalizeTarget("seo audit"));
    expect(normalizeTarget("best crm")).not.toBe(normalizeTarget("crm pricing"));
  });

  it("does not strip a double-s ending into a different word", () => {
    expect(normalizeTarget("business")).toBe("business");
  });

  it("is order independent", () => {
    expect(normalizeTarget("content marketing")).toBe(normalizeTarget("marketing content"));
  });

  it("folds agent and verbal-noun endings, so the writer and the writing are one target", () => {
    // Caught by the autonomous queue: it planned "seo content writing" and
    // "seo content writer" as two articles. Same results page, same reader.
    const a = normalizeTarget("seo content writing");
    expect(normalizeTarget("seo content writer")).toBe(a);
    expect(normalizeTarget("seo content writers")).toBe(a);
    expect(normalizeTarget("seo content writers' guide")).toBe(normalizeTarget("seo content writing guide"));
    expect(normalizeTarget("link building")).toBe(normalizeTarget("link builder"));
  });

  it("leaves a short word whole rather than stemming it to nothing", () => {
    // "user" is not "us", "thing" is not "th": the ending must leave a stem
    // that still says what the word was.
    expect(normalizeTarget("user")).toBe("user");
    expect(normalizeTarget("thing")).toBe("thing");
    expect(normalizeTarget("string")).toBe("string");
  });

  it("folds a silent final e, so the singular meets its own plural", () => {
    // The plural fold produced "websit" from "websites" while "website" stayed
    // whole, so the two halves of the same fold never met. qasimcode.com was
    // given "website design", "website about design" and "website design
    // websites" as three targets, and all three were scheduled.
    const a = normalizeTarget("website design");
    expect(normalizeTarget("website about design")).toBe(a);
    expect(normalizeTarget("website design websites")).toBe(a);
    expect(normalizeTarget("create business websites")).toBe(
      normalizeTarget("creating business websites"),
    );
    expect(normalizeTarget("guide")).toBe(normalizeTarget("guides"));
  });

  it("counts a repeated word once", () => {
    // "business ideas for small businesses" is "idea for small businesses"
    // said twice. Both were stored, both were scheduled.
    expect(normalizeTarget("business ideas for small businesses")).toBe(
      normalizeTarget("idea for small businesses"),
    );
    expect(normalizeTarget("ideas on small businesses")).toBe(
      normalizeTarget("idea for small businesses"),
    );
  });

  it("still keeps genuinely different queries apart after the extra folds", () => {
    expect(normalizeTarget("website design")).not.toBe(normalizeTarget("website hosting"));
    expect(normalizeTarget("dental clinic website")).not.toBe(
      normalizeTarget("beauty salon website"),
    );
    // A word that merely ends in "e" is not a plural of anything.
    expect(normalizeTarget("code")).toBe("code");
    expect(normalizeTarget("site")).toBe("site");
  });
});
