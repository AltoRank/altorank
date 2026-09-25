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

function verdict(language: string, organicUrls: string[] | null) {
  const fingerprint = contextKey({ business: BUSINESS, domain: DOMAIN, languageCode: language, locationCode: 2792 });
  if (!organicUrls) return { version: OPPORTUNITY_VERSION, context: fingerprint, checkedAt: new Date().toISOString(), status: "pending", cause: "no_verdict", reason: "not yet" };
  return {
    version: OPPORTUNITY_VERSION, context: fingerprint, checkedAt: new Date().toISOString(), status: "qualified",
    reason: "Buyers compare agencies before hiring one", audience: "companies", buyingJob: "hire an agency", offering: "app development",
    angle: "How to choose", format: "article", conversionPath: `https://${DOMAIN}`, evidenceUrls: organicUrls.slice(0, 2), organicUrls,
  };
}

type Row = { id: string; term: string; status: string; opportunity: unknown; plan_excluded_at?: string | null };
const row = (id: string, term: string, status: string, opportunity: unknown): Row => ({ id, term, status, opportunity, plan_excluded_at: null });

const writes: Array<{ table: string; op: string; value: unknown; filters: unknown[][] }> = [];

function client(rows: Row[], articles: unknown[], language = "tr", entries: unknown[] = []): SupabaseClient {
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
    const bare = [
      row("d", SIRKETLERI, "drafting", null),
      row("q", FIRMALARI, "planned", verdict("tr", null)),
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
