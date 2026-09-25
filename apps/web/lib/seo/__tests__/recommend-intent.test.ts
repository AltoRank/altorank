import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A drafted keyword owns its search. A real signup (2026-09-22, a Turkish web
 * and mobile agency) had "mobil uygulama geliştirme şirketleri" drafted,
 * "... firmaları" queued for the next day and "... firması" held for the
 * trial: one search, three spellings. The recommender compared candidates with
 * each other and never with what was already written, so the queued one would
 * have been written the next night.
 */

const { ensure, qualify } = vi.hoisted(() => ({ ensure: vi.fn(), qualify: vi.fn() }));
vi.mock("@/lib/keyword-research/business-context", () => ({ ensureBusinessProfile: (...a: unknown[]) => ensure(...a) }));
vi.mock("@/lib/keyword-research/opportunity", async () => {
  const real = await vi.importActual<typeof import("@/lib/keyword-research/opportunity")>("@/lib/keyword-research/opportunity");
  return { ...real, qualifyOpportunities: (...a: unknown[]) => qualify(...a) };
});

import { recommendKeywords, pickNextKeyword } from "../recommendations";
import { contextKey, OPPORTUNITY_VERSION } from "@/lib/keyword-research/opportunity";

const DOMAIN = "acme-agency.example";
const BUSINESS = { description: "Acme builds mobile apps and websites for companies.", offerings: ["mobile app development"], audiences: ["companies"], competitors: [] };

const page = (prefix: string, n = 10) => Array.from({ length: n }, (_, i) => `https://${prefix}-${i}.example/sayfa-${i}`);
const serp = (base: string[], shared: number, prefix: string) => [...base.slice(0, shared), ...page(prefix, 10 - shared)];
const OWNER = page("owner");

const fingerprintFor = (language: string) => contextKey({ business: BUSINESS, domain: DOMAIN, languageCode: language, locationCode: 2792 });
function refused(language: string) {
  return { version: OPPORTUNITY_VERSION, context: fingerprintFor(language), checkedAt: new Date().toISOString(), status: "rejected", cause: "buyer_mismatch", reason: "no buyer" };
}
function verdict(language: string, organicUrls: string[] | null) {
  const fingerprint = fingerprintFor(language);
  if (!organicUrls) return { version: OPPORTUNITY_VERSION, context: fingerprint, checkedAt: new Date().toISOString(), status: "pending", cause: "no_verdict", reason: "not yet" };
  return {
    version: OPPORTUNITY_VERSION, context: fingerprint, checkedAt: new Date().toISOString(), status: "qualified",
    reason: "Buyers compare agencies before hiring one", audience: "companies", buyingJob: "hire an agency", offering: "app development",
    angle: "How to choose", format: "article", conversionPath: `https://${DOMAIN}`, evidenceUrls: organicUrls.slice(0, 2), organicUrls,
  };
}

type Row = { id: string; term: string; status: string; opportunity: unknown; plan_excluded_at?: string | null; volume?: number };
const row = (id: string, term: string, status: string, opportunity: unknown, extra: Partial<Row> = {}): Row => ({ id, term, status, opportunity, plan_excluded_at: null, ...extra });

const writes: Array<{ table: string; op: string; value: unknown; filters: unknown[][] }> = [];

function client(rows: Row[], articles: unknown[], language = "tr", entries: unknown[] = [], failing: string | null = null): SupabaseClient {
  return {
    from(table: string) {
      const filters: unknown[][] = [];
      let op = "select";
      let value: unknown = null;
      const data = () =>
        table === "keywords" ? rows.map((r) => ({ volume: 480, difficulty: 8, intent: "commercial", source: null, source_type: "seed", source_ref: null, source_url: null, buyer_fit: { keep: true, reason: null, funnel: "buyer" }, ...r }))
          : table === "articles" ? articles
            : table === "calendar_entries" ? entries : [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "gte", "not", "is"]) q[m] = (...args: unknown[]) => { filters.push([m, ...args]); return q; };
      for (const m of ["update", "delete"]) q[m] = (v?: unknown) => { op = m; value = v ?? null; return q; };
      q.single = async () => ({ data: { topical_profile: null, dr: 20, business_profile: BUSINESS, domain: DOMAIN, language, location_code: 2792, auto_generate_weekly_limit: 3 } });
      q.then = (resolve: (v: unknown) => unknown) => {
        if (op !== "select") writes.push({ table, op, value, filters });
        if (op === "select" && table === failing) return resolve({ data: null, error: { message: "canceling statement due to statement timeout" } });
        return resolve(op === "select" ? { data: data(), error: null } : { data: null, error: null, count: 1 });
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  writes.length = 0;
  ensure.mockReset().mockResolvedValue({ business: BUSINESS, inferred: false, missing: null });
  qualify.mockReset().mockImplementation(() => { throw new Error("nothing should be bought: every verdict is cached"); });
});

const SIRKETLERI = "mobil uygulama geliştirme şirketleri";
const FIRMALARI = "mobil uygulama geliştirme firmaları";
const FIRMASI = "mobil uygulama geliştirme firması";
const OTHER = "kurumsal web tasarım fiyatları";

describe("recommendKeywords: a drafted keyword blocks its near-duplicates", () => {
  const rows = [
    row("d", SIRKETLERI, "drafting", verdict("tr", OWNER)),
    row("q", FIRMALARI, "planned", verdict("tr", serp(OWNER, 6, "q"))),
    row("h", FIRMASI, "new", verdict("tr", serp(OWNER, 5, "h"))),
    row("o", OTHER, "new", verdict("tr", page("o"))),
  ];
  const articles = [{ id: "art-d", keyword: SIRKETLERI, keyword_id: "d", status: "review" }];

  it("skips the queued and the held spelling, names the drafted one, and writes something else", async () => {
    const recs = await recommendKeywords(client(rows, articles), "ws", { limit: 100 });
    const q = recs.find((r) => r.keywordId === "q")!;
    const h = recs.find((r) => r.keywordId === "h")!;
    expect(q.action).toBe("skip");
    expect(q.reasons[0]).toBe(`Same search as “${SIRKETLERI}”, already drafted: the same 6 of the top 10 results. One article per search.`);
    expect(h.action).toBe("skip");
    expect(h.opportunity).toMatchObject({ status: "rejected", cause: "duplicate", duplicateOf: "d", intentBasis: "serp" });
    expect(pickNextKeyword(recs)?.term).toBe(OTHER);
    // A list page reads; it does not park.
    expect(writes).toEqual([]);
  });

  it("a qualifying caller parks them the way it parks a refusal, and takes the queued one off the calendar", async () => {
    const recs = await recommendKeywords(client(rows, articles, "tr", [{ id: "entry-q" }]), "ws", { limit: 100, qualify: true });
    expect(qualify).not.toHaveBeenCalled();
    expect(pickNextKeyword(recs)?.term).toBe(OTHER);
    const parked = writes.filter((w) => w.table === "keywords" && w.op === "update");
    expect(parked.map((w) => w.filters.find((f) => f[0] === "eq" && f[1] === "id")?.[2]).sort()).toEqual(["h", "q"]);
    for (const w of parked) {
      expect(w.value).toMatchObject({ status: "stored", opportunity: { status: "rejected", cause: "duplicate", duplicateOf: "d", duplicateTerm: SIRKETLERI } });
      expect((w.value as { plan_excluded_at: string }).plan_excluded_at).toBeTruthy();
    }
    expect(writes.some((w) => w.table === "calendar_entries" && w.op === "delete")).toBe(true);
    // The drafted keyword itself is never parked.
    expect(parked.some((w) => w.filters.some((f) => f[2] === "d"))).toBe(false);
  });

  it("without stored results pages, folds the Turkish inflection and leaves the synonym to qualification", async () => {
    // Three results are too few to compare pages by (the bar is four shared),
    // so every pair here is decided by its words.
    const bare = [
      row("d", SIRKETLERI, "drafting", null),
      row("q", FIRMALARI, "planned", verdict("tr", page("q", 3))),
      row("h", FIRMASI, "new", verdict("tr", null)),
      row("o", OTHER, "new", verdict("tr", page("o"))),
    ];
    const recs = await recommendKeywords(client(bare, articles), "ws", { limit: 100 });
    const h = recs.find((r) => r.keywordId === "h")!;
    expect(h.action).toBe("skip");
    expect(h.reasons[0]).toBe(`Same search as “${FIRMALARI}”, on the calendar: the same words. One article per search.`);
    // "şirket" and "firma" are synonyms: the words cannot see it, and do not pretend to.
    expect(recs.find((r) => r.keywordId === "q")!.reasons.join(" ")).not.toContain("Same search");
  });

  it("does not merge a keyword that only shares words with a drafted one", async () => {
    const recs = await recommendKeywords(client([
      row("d", SIRKETLERI, "drafting", verdict("tr", OWNER)),
      row("w", "mobil uygulama geliştirme maliyeti", "new", verdict("tr", serp(OWNER, 3, "w"))),
    ], articles), "ws", { limit: 100 });
    expect(recs.find((r) => r.keywordId === "w")!.action).toBe("write");
  });

  it("compares an article by its keyword row's results page, whatever that row's status now", async () => {
    // The article's row went back to "new" (an unwritten plan entry removed,
    // say); the article is still live, and its results page still says which
    // search it answers. The synonym gets no second article.
    const recs = await recommendKeywords(client([
      row("a", SIRKETLERI, "new", verdict("tr", OWNER)),
      row("s", FIRMALARI, "new", verdict("tr", serp(OWNER, 5, "s"))),
    ], [{ id: "art-a", keyword: SIRKETLERI, keyword_id: "a", status: "live" }]), "ws", { limit: 100 });
    const s = recs.find((r) => r.keywordId === "s")!;
    expect(s.action).toBe("skip");
    expect(s.reasons[0]).toBe(`Same search as “${SIRKETLERI}”, already live: the same 5 of the top 10 results. One article per search.`);
  });

  it("says when a language has no rule set for comparing with pages that carry no results page", async () => {
    const recs = await recommendKeywords(client(
      [row("o", "agenzia sviluppo app", "new", verdict("it", page("o")))],
      [{ id: "a1", keyword: "agenzie sviluppo app", keyword_id: null, status: "live" }],
      "it",
    ), "ws", { limit: 100 });
    const o = recs.find((r) => r.keywordId === "o")!;
    // "agenzie"/"agenzia" are not folded for Italian: not merged, and said.
    expect(o.action).toBe("write");
    expect(o.reasons).toContain("Checked against your existing pages by exact words: inflected spellings not compared for Italian.");
  });
});

describe("recommendKeywords: only a planned row that will still be written owns its search", () => {
  const parkedIds = () => writes
    .filter((w) => w.table === "keywords" && w.op === "update")
    .map((w) => ({ id: w.filters.find((f) => f[0] === "eq" && f[1] === "id")?.[2], value: w.value as { status: string; opportunity: Record<string, unknown> } }));

  it("a refused planned row does not park the phrasing that can be written; it comes off the calendar itself", async () => {
    // The reviewer's case: the calendar holds a phrasing the buyer test has
    // since refused, and a writable phrasing of the same search is approved.
    // Led by the refused one, the writable one was parked as "on the
    // calendar", the refused one was never written, and the search was lost.
    const recs = await recommendKeywords(client([
      row("p", "seo agencies", "planned", refused("en")),
      row("c", "agency seo", "new", verdict("en", page("c"))),
    ], [], "en", [{ id: "entry-p", keyword_id: "p", scheduled_date: "2026-09-26" }]), "ws", { limit: 100, qualify: true });
    expect(qualify).not.toHaveBeenCalled();
    expect(pickNextKeyword(recs)?.keywordId).toBe("c");
    const parked = parkedIds();
    expect(parked.map((p) => p.id)).toEqual(["p"]);
    // Parked with its own refusal, the way the refill parks every refusal.
    expect(parked[0].value).toMatchObject({ status: "stored", opportunity: { status: "rejected", cause: "buyer_mismatch" } });
    expect(writes.some((w) => w.table === "calendar_entries" && w.op === "delete")).toBe(true);
  });

  it("a list page reads the same answer and parks nothing", async () => {
    const recs = await recommendKeywords(client([
      row("p", "seo agencies", "planned", refused("en")),
      row("c", "agency seo", "new", verdict("en", page("c"))),
    ], [], "en"), "ws", { limit: 100 });
    expect(pickNextKeyword(recs)?.keywordId).toBe("c");
    expect(recs.find((r) => r.keywordId === "c")!.reasons.join(" ")).not.toContain("Same search");
    expect(writes).toEqual([]);
  });

  it("a planned row whose approval lapsed does not own the search; the sibling is judged, and once approved the planned row comes off", async () => {
    qualify.mockReset().mockImplementation(async (_s: unknown, _w: unknown, asked: Array<{ id: string }>) =>
      new Map(asked.map((c) => [c.id, verdict("en", page(c.id))])));
    const recs = await recommendKeywords(client([
      row("p", "seo agencies", "planned", null),
      row("c", "agency seo", "new", null),
    ], [], "en", [{ id: "entry-p", keyword_id: "p", scheduled_date: "2026-09-26" }]), "ws", { limit: 100, qualify: true });
    // Judged against this pass's owners, which do not include the lapsed row:
    // qualification must not refuse the sibling as its duplicate.
    expect((qualify.mock.calls[0][2] as Array<{ id: string }>).map((c) => c.id)).toEqual(["c"]);
    const owners = (qualify.mock.calls[0][4] as { owners: Array<{ keywordId: string | null }> }).owners;
    expect(owners.some((o) => o.keywordId === "p")).toBe(false);
    expect(pickNextKeyword(recs)?.keywordId).toBe("c");
    const parked = parkedIds();
    expect(parked.map((p) => p.id)).toEqual(["p"]);
    expect(parked[0].value.opportunity).toMatchObject({ status: "rejected", cause: "duplicate", duplicateOf: "c", duplicateTerm: "agency seo" });
    expect(parked[0].value.opportunity.reason).toBe("Same search as “agency seo”, approved and next in the queue: the same words. One article per search.");
  });

  it("while the sibling is still unjudged, the lapsed planned row keeps its calendar entry", async () => {
    qualify.mockReset().mockImplementation(async (_s: unknown, _w: unknown, asked: Array<{ id: string }>) =>
      new Map(asked.map((c) => [c.id, verdict("en", null)])));
    await recommendKeywords(client([
      row("p", "seo agencies", "planned", null),
      row("c", "agency seo", "new", null),
    ], [], "en", [{ id: "entry-p", keyword_id: "p", scheduled_date: "2026-09-26" }]), "ws", { limit: 100, qualify: true });
    expect(parkedIds()).toEqual([]);
    expect(writes.some((w) => w.table === "calendar_entries" && w.op === "delete")).toBe(false);
  });

  it("an approved planned row the scorer now refuses does not own the search either", async () => {
    // No measured demand any more (volume 0): the cron would overrule the
    // entry on its day, so it cannot hold the search against a phrasing that
    // will be written.
    const recs = await recommendKeywords(client([
      row("p", "seo agencies", "planned", verdict("en", page("p")), { volume: 0 }),
      row("c", "agency seo", "new", verdict("en", serp(page("p"), 6, "c"))),
    ], [], "en", [{ id: "entry-p", keyword_id: "p", scheduled_date: "2026-09-26" }]), "ws", { limit: 100, qualify: true });
    expect(pickNextKeyword(recs)?.keywordId).toBe("c");
    expect(parkedIds().map((p) => p.id)).toEqual(["p"]);
    expect(parkedIds()[0].value.opportunity).toMatchObject({ cause: "duplicate", duplicateOf: "c" });
  });

  it("an approved, writable planned row still owns its search and parks a later phrasing", async () => {
    const recs = await recommendKeywords(client([
      row("p", "seo agencies", "planned", verdict("en", page("p"))),
      row("c", "agency seo", "new", verdict("en", serp(page("p"), 6, "c")), { volume: 9000 }),
    ], [], "en", [{ id: "entry-p", keyword_id: "p", scheduled_date: "2026-09-26" }]), "ws", { limit: 100, qualify: true });
    expect(recs.find((r) => r.keywordId === "c")!.reasons[0]).toBe("Same search as “seo agencies”, on the calendar: the same 6 of the top 10 results. One article per search.");
    expect(parkedIds().map((p) => p.id)).toEqual(["c"]);
  });

  it("of two planned phrasings of one search, the one due first is kept, whatever the scores", async () => {
    await recommendKeywords(client([
      row("late", "seo agencies", "planned", verdict("en", serp(page("soon"), 7, "late")), { volume: 9000 }),
      row("soon", "agency seo", "planned", verdict("en", page("soon"))),
    ], [], "en", [
      { id: "entry-late", keyword_id: "late", scheduled_date: "2026-10-20" },
      { id: "entry-soon", keyword_id: "soon", scheduled_date: "2026-09-26" },
    ]), "ws", { limit: 100, qualify: true });
    const parked = parkedIds();
    expect(parked.map((p) => p.id)).toEqual(["late"]);
    expect(parked[0].value.opportunity).toMatchObject({ cause: "duplicate", duplicateOf: "soon" });
  });
});

describe("recommendKeywords: the leaders are read or nothing is picked", () => {
  // A failed read of the articles used to become an empty list, and the next
  // draft was the search a live article already held, with nothing logged.
  const live = [{ id: "art-live", keyword: FIRMASI, keyword_id: null, status: "live" }];
  const rows = [row("c", FIRMASI, "new", verdict("tr", page("c")))];

  it("does not pick a search a live article holds", async () => {
    const recs = await recommendKeywords(client(rows, live), "ws", { limit: 50, qualify: true });
    expect(pickNextKeyword(recs)?.term).not.toBe(FIRMASI);
  });

  for (const table of ["articles", "site_pages", "calendar_entries"]) {
    it(`throws, naming ${table}, when that read fails`, async () => {
      await expect(recommendKeywords(client(rows, live, "tr", [], table), "ws", { limit: 50, qualify: true })).rejects.toThrow(
        `could not read ${table}`,
      );
    });
  }

  it("keeps going without a Search Console read: that one is a signal", async () => {
    const recs = await recommendKeywords(client(rows, live, "tr", [], "analytics_metrics"), "ws", { limit: 50, qualify: true });
    expect(recs.length).toBeGreaterThan(0);
  });
});
