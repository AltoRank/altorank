import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const hold = vi.fn(async (): Promise<"open" | "held" | "spent"> => "held");
vi.mock("@/lib/billing/trial-hold", async () => {
  const real = await vi.importActual<typeof import("@/lib/billing/trial-hold")>("@/lib/billing/trial-hold");
  return { ...real, planHold: () => hold() };
});
const decorate = vi.fn(async (..._a: unknown[]) => ({ classified: 0, questioned: 0 }));
vi.mock("../plan", () => ({ decoratePlannedKeywords: (...a: unknown[]) => decorate(...a) }));

import { MAX_RESULTS_READS, planFirstLook } from "../first-look-plan";
import { contextKey, readOpportunity } from "@/lib/keyword-research/opportunity";
import type { SerpData } from "@/lib/seo/brief-data";

// --- A small in-memory database: the tables and filters the planner uses ----

type Row = Record<string, unknown>;
function memoryDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { keywords: [], calendar_entries: [], site_pages: [], keyword_rankings: [], workspaces: [], ...seed };
  let ids = 0;
  const client = {
    from(table: string) {
      const rows = () => (tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "insert" | "update" | "delete" = "select";
      let payload: Row | Row[] | null = null;
      const q: Record<string, unknown> = {};
      const matching = () => rows().filter((r) => filters.every((f) => f(r)));
      const run = () => {
        if (op === "insert") {
          const added = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: `${table}-${++ids}`, ...r }));
          rows().push(...added);
          return { data: added, error: null };
        }
        if (op === "update") { for (const r of matching()) Object.assign(r, payload); return { data: null, error: null }; }
        if (op === "delete") { tables[table] = rows().filter((r) => !filters.every((f) => f(r))); return { data: null, error: null }; }
        return { data: matching(), error: null };
      };
      q.select = () => q;
      q.insert = (p: Row | Row[]) => { op = "insert"; payload = p; return q; };
      q.update = (p: Row) => { op = "update"; payload = p; return q; };
      q.delete = () => { op = "delete"; return q; };
      q.eq = (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; };
      q.in = (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return q; };
      q.is = (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; };
      q.limit = () => q;
      q.single = async () => { const { data } = run(); return { data: Array.isArray(data) ? data[0] ?? null : data, error: null }; };
      q.maybeSingle = q.single;
      q.then = (resolve: (v: unknown) => unknown) => resolve(run());
      return q;
    },
  };
  return { db: client as unknown as SupabaseClient, tables };
}

// --- The site ------------------------------------------------------------------

const BUSINESS = {
  name: "Example Relief",
  description: "Independent guides to public support schemes for citizens.",
  audiences: ["citizens seeking public support"],
  offerings: ["scheme guides", "eligibility checker"],
  competitors: ["rivalaid.example"],
  conversionUrl: "https://relief.example/find-schemes/",
};
const WS = { id: "ws1", domain: "relief.example", language: "en", location_code: 2586, dr: 3, business_profile: BUSINESS };
const topic = (query: string, over: Record<string, unknown> = {}) => ({
  query, fromList: false, reader: "Citizens seeking support", job: `Understand ${query}`, offering: "The scheme guides",
  angle: `${query[0].toUpperCase()}${query.slice(1)}: a plain guide`, shape: "howTo", fit: 4, kind: "question", why: "Its readers ask this before they apply.", ...over,
});
const articles = (term: string): SerpData => ({
  organic: [1, 2, 3, 4].map((n) => ({ rank: n, title: `${term}: a guide (${n})`, url: `https://news-${n}.example/blog/${term.replace(/ /g, "-")}`, description: `A guide to ${term}.`, domain: `news-${n}.example`, wordCount: 900 })),
  peopleAlsoAsk: [],
  aiOverview: null,
});
const providers = (term: string): SerpData => ({
  organic: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ rank: n, title: `${term} | Agency ${n} | Book now`, url: `https://agency-${n}.example/`, description: `${term} done for you. Call us`, domain: `agency-${n}.example`, wordCount: 300 })),
  peopleAlsoAsk: [],
  aiOverview: null,
});

const reply = (topics: unknown[]) => vi.fn(async (..._a: unknown[]) => JSON.stringify({ topics }));

function setup(over: { keywords?: Row[]; calendar?: Row[] } = {}) {
  return memoryDb({
    workspaces: [{ ...WS }],
    keywords: over.keywords ?? [],
    calendar_entries: over.calendar ?? [],
    site_pages: [{ workspace_id: "ws1", url: "https://relief.example/find-schemes/", path: "/find-schemes/", title: "Find schemes", h1: null }],
  });
}
const base = () => ({ firstLook: { serps: new Map<string, SerpData>() }, weeklyLimit: 2, rivalPages: async () => [], metrics: async () => new Map(), now: new Date("2026-10-25T12:00:00Z") });

beforeEach(() => {
  hold.mockReset().mockResolvedValue("held");
  decorate.mockClear();
});

describe("planFirstLook", () => {
  it("plans a first article for a site whose readers are citizens, every topic unmeasured and every buyer-test verdict a no", async () => {
    // The 2026-10-25 case, in neutral words: discovery's pool was parked by
    // the buyer test and nothing had a reported volume.
    const parked = ["housing grant status check", "who qualifies for the housing grant"].map((term, i) => ({
      id: `k${i}`, workspace_id: "ws1", term, volume: null, difficulty: null, status: "stored", plan_excluded_at: "2026-10-25T10:00:00Z",
      opportunity: { status: "rejected", cause: "buyer_mismatch" },
    }));
    const { db, tables } = setup({ keywords: parked });
    const ask = reply([topic("who qualifies for the housing grant", { fromList: true, fit: 5 }), topic("how to apply for the housing grant"), topic("rivalaid housing grant")]);
    const serp = vi.fn(async (term: string) => articles(term));
    const out = await planFirstLook(db, "ws1", { ...base(), ask, serp });

    expect(out.outcome).toBe("planned");
    expect(out.plan).toHaveLength(1);
    expect(out.plan[0].term).toBe("who qualifies for the housing grant");
    // The parked row is reused, unparked and planned, not duplicated.
    const row = tables.keywords.find((r) => r.term === "who qualifies for the housing grant")!;
    expect(row).toMatchObject({ id: "k1", status: "planned", plan_excluded_at: null });
    expect(tables.keywords.filter((r) => r.term === "who qualifies for the housing grant")).toHaveLength(1);
    // The brief is the one the writer reads back, honest about demand.
    const fingerprint = contextKey({ business: BUSINESS, domain: "relief.example", languageCode: "en", locationCode: 2586 });
    const brief = readOpportunity(row.opportunity, fingerprint)!;
    expect(brief).toMatchObject({ status: "qualified", demand: "unmeasured", audience: "Citizens seeking support" });
    expect(brief.firstLookScore?.total).toBeGreaterThan(0);
    // A rival's name is removed before anything is bought for it.
    expect(out.summary.rejected).toEqual({ brand: 1 });
    expect(serp).not.toHaveBeenCalledWith("rivalaid housing grant", expect.anything());
    // One model call.
    expect(ask).toHaveBeenCalledTimes(1);
    expect(out.summary.modelCalls).toBe(1);
    expect(out.summary.chosen?.line).toMatch(/demand unmeasured/);
    // The runner-up is kept with its brief: what the trial opens.
    expect(out.summary.ready).toBe(1);
    expect(tables.keywords.find((r) => r.term === "how to apply for the housing grant")).toMatchObject({ status: "new", source_type: "profile" });
    // On the calendar, and the results page is handed on for the draft.
    expect(tables.calendar_entries).toHaveLength(1);
    expect(tables.calendar_entries[0]).toMatchObject({ keyword: "who qualifies for the housing grant", status: "queue" });
    expect(out.selection.get("who qualifies for the housing grant")?.reasons.join(" ")).toMatch(/unmeasured/);
    expect(decorate).toHaveBeenCalledTimes(1);
  });

  it("ranks measured demand above unmeasured, all else equal", async () => {
    const { db } = setup({ keywords: [{ id: "m1", workspace_id: "ws1", term: "housing grant amount", volume: 1_900, difficulty: 8, status: "new", plan_excluded_at: null }] });
    const ask = reply([topic("housing grant documents"), topic("housing grant amount", { fromList: true })]);
    const out = await planFirstLook(db, "ws1", { ...base(), ask, serp: async (t) => articles(t) });
    expect(out.plan[0].term).toBe("housing grant amount");
    expect(out.plan[0].brief?.demand).toBeUndefined();
  });

  it("removes a search whose results are providers' pages, and plans the next", async () => {
    const { db } = setup();
    const ask = reply([topic("housing grant consultant", { fit: 5 }), topic("housing grant documents", { fit: 3 })]);
    const out = await planFirstLook(db, "ws1", { ...base(), ask, serp: async (t) => (t === "housing grant consultant" ? providers(t) : articles(t)) });
    expect(out.plan.map((p) => p.term)).toEqual(["housing grant documents"]);
    expect(out.summary.rejected).toEqual({ needs_page: 1 });
  });

  it("stops reading results pages once no unread topic could beat the picks", async () => {
    const { db } = setup();
    const many = Array.from({ length: 20 }, (_, i) => topic(`housing grant question ${String.fromCharCode(97 + i)}`, { fit: i < 2 ? 5 : 2 }));
    const serp = vi.fn(async (t: string) => articles(t));
    const out = await planFirstLook(db, "ws1", { ...base(), ask: reply(many), serp });
    expect(out.plan).toHaveLength(1);
    expect(serp.mock.calls.length).toBeLessThanOrEqual(4);
    expect(serp.mock.calls.length).toBeLessThan(MAX_RESULTS_READS);
  });

  it("plans up to five for an account the trial does not hold", async () => {
    hold.mockResolvedValue("open");
    const { db, tables } = setup();
    const ask = reply(Array.from({ length: 8 }, (_, i) => topic(`housing grant question ${String.fromCharCode(97 + i)}`)));
    const out = await planFirstLook(db, "ws1", { ...base(), maxEntries: 5, ask, serp: async (t) => articles(t) });
    expect(out.plan).toHaveLength(5);
    expect(new Set(out.plan.map((p) => p.date)).size).toBe(5);
    expect(tables.calendar_entries).toHaveLength(5);
  });

  it("is ours, not the site's, when the model does not answer or no results page could be read", async () => {
    const { db } = setup();
    expect((await planFirstLook(db, "ws1", { ...base(), ask: vi.fn(async () => null) })).outcome).toBe("provider");
    const failing = await planFirstLook(db, "ws1", { ...base(), ask: reply([topic("housing grant documents")]), serp: async () => { throw new Error("DataForSEO 402"); } });
    expect(failing.outcome).toBe("provider");
    expect(failing.summary.resultsFailed).toBe(1);
  });

  it("plans from the topics a cut-off reply finished, and calls a reply with none unreadable, not an outage", async () => {
    const whole = JSON.stringify({ topics: [topic("housing grant documents"), topic("housing grant appeal")] });
    const cut = whole.slice(0, whole.indexOf("housing grant appeal") + 8);
    const ask = vi.fn(async (_op: string, _p: string, o: { onStop?: (r: string | null) => void }) => { o.onStop?.("max_tokens"); return cut; });
    const out = await planFirstLook(setup().db, "ws1", { ...base(), ask, serp: async (t) => articles(t) });
    expect(out.outcome).toBe("planned");
    expect(out.summary.suggested).toBe(1);
    expect(out.plan.map((p) => p.term)).toEqual(["housing grant documents"]);
    const none = await planFirstLook(setup().db, "ws1", { ...base(), ask: vi.fn(async () => '{"topics": [{"query": "housing') });
    expect(none.outcome).toBe("unreadable");
  });

  it("plans nothing new once the trial's one article is spent or the calendar is full", async () => {
    hold.mockResolvedValue("spent");
    const ask = reply([topic("housing grant documents")]);
    expect((await planFirstLook(setup().db, "ws1", { ...base(), ask })).outcome).toBe("spent");
    hold.mockResolvedValue("held");
    const written = { workspace_id: "ws1", keyword_id: "k9", keyword: "x", scheduled_date: "2026-10-20", article_id: "a1", status: "queue" };
    expect((await planFirstLook(setup({ calendar: [written] }).db, "ws1", { ...base(), ask })).outcome).toBe("full");
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not offer a topic a person took off the planner or one already planned", async () => {
    const { db } = setup({ keywords: [
      { id: "x1", workspace_id: "ws1", term: "housing grant documents", volume: 500, difficulty: 5, status: "new", plan_excluded_at: "2026-10-24T00:00:00Z" },
      { id: "x2", workspace_id: "ws1", term: "housing grant amount", volume: 500, difficulty: 5, status: "planned", plan_excluded_at: null },
    ] });
    const ask = reply([topic("housing grant documents"), topic("housing grant amount"), topic("housing grant deadline")]);
    const out = await planFirstLook(db, "ws1", { ...base(), ask, serp: async (t) => articles(t) });
    expect(out.plan.map((p) => p.term)).toEqual(["housing grant deadline"]);
    const prompt = ask.mock.calls[0][1] as string;
    expect(prompt).not.toContain("housing grant documents (");
  });
});
