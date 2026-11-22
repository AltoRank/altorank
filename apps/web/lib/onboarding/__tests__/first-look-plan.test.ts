import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const hold = vi.fn(async (): Promise<"open" | "held" | "spent"> => "held");
vi.mock("@/lib/billing/trial-hold", async () => {
  const real = await vi.importActual<typeof import("@/lib/billing/trial-hold")>("@/lib/billing/trial-hold");
  return { ...real, planHold: () => hold() };
});
const decorate = vi.fn(async (..._a: unknown[]) => ({ classified: 0, questioned: 0 }));
vi.mock("../plan", () => ({ decoratePlannedKeywords: (...a: unknown[]) => decorate(...a) }));

import { HARD_MAX_READS, MAX_RESULTS_READS, planFirstLook } from "../first-look-plan";
import { BudgetRefusedError } from "@/lib/billing/spend-scope";
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

/** Providers' pages win it, and one article in the results is there to cite. */
const crowded = (term: string): SerpData => ({
  ...providers(term),
  organic: [...providers(term).organic, { rank: 8, title: `${term}: a guide`, url: `https://news-8.example/blog/${term.replace(/ /g, "-")}`, description: `A guide to ${term}.`, domain: "news-8.example", wordCount: 900 }],
});
const FINGERPRINT = contextKey({ business: BUSINESS, domain: "relief.example", languageCode: "en", locationCode: 2586 });

const reply = (topics: unknown[]) => vi.fn(async (..._a: unknown[]) => JSON.stringify({ topics }));
/** The first ask's topics, then the second ask's: told apart by the operation, as production's are. */
const replies = (first: unknown[] | string | null, second: unknown[] | null) => vi.fn(async (operation: string, ..._a: unknown[]) => {
  const answer = operation.endsWith("second-ask") ? second : first;
  return answer === null || typeof answer === "string" ? answer : JSON.stringify({ topics: answer });
});
const lettered = (n: number, over: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => topic(`housing grant office ${String.fromCharCode(97 + i)}`, over));

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

  it("keeps a search whose words ask a question on a providers' page, at lower confidence", async () => {
    const { db, tables } = setup();
    const ask = reply([topic("housing grant consultant", { fit: 5 }), topic("how to appeal a housing grant decision", { fit: 3 })]);
    const out = await planFirstLook(db, "ws1", { ...base(), ask, serp: async (t) => (t === "housing grant consultant" ? providers(t) : crowded(t)) });
    expect(out.plan.map((p) => p.term)).toEqual(["how to appeal a housing grant decision"]);
    expect(out.summary.rejected).toEqual({ needs_page: 1 });
    expect(out.summary.floor).toBeUndefined();
    const row = tables.keywords.find((r) => r.term === "how to appeal a housing grant decision")!;
    expect(readOpportunity(row.opportunity, FINGERPRINT)).toMatchObject({ status: "qualified", confidence: "lower" });
    expect(out.selection.get("how to appeal a housing grant decision")?.reasons.join(" ")).toMatch(/Providers' own pages win most of this search/);
  });

  it("plans the best providers' page with an article to cite when every page read was providers' pages: the floor", async () => {
    const { db, tables } = setup();
    const ask = reply([topic("housing grant consultant", { fit: 5 }), topic("housing grant agency", { fit: 4 }), topic("housing grant lawyer", { fit: 5 })]);
    // The lawyer search outscores the rest but its page has nothing to cite.
    const serp = async (t: string) => (t === "housing grant lawyer" ? providers(t) : crowded(t));
    const out = await planFirstLook(db, "ws1", { ...base(), ask, serp });
    expect(out.outcome).toBe("planned");
    expect(out.plan.map((p) => p.term)).toEqual(["housing grant consultant"]);
    expect(out.summary).toMatchObject({ floor: true, planned: 1, ready: 0, rejected: { needs_page: 3 } });
    const row = tables.keywords.find((r) => r.term === "housing grant consultant")!;
    expect(row.status).toBe("planned");
    expect(readOpportunity(row.opportunity, FINGERPRINT)).toMatchObject({ status: "qualified", confidence: "lower" });
    // The floor plans the first article only, not a list of weak ones.
    expect(tables.keywords.filter((r) => r.term === "housing grant agency")).toHaveLength(0);
    expect(tables.calendar_entries).toHaveLength(1);
  });

  it("proposes its best topic to the owner when nothing read has anything to cite, after one second ask", async () => {
    const { db, tables } = setup();
    const ask = replies([topic("housing grant consultant", { fit: 5 }), topic("housing grant agency")], []);
    const out = await planFirstLook(db, "ws1", { ...base(), ask, serp: async (t) => providers(t) });
    expect(out.outcome).toBe("needs_owner_input");
    expect(out.plan).toEqual([]);
    expect(out.summary).toMatchObject({ planned: 0, proposed: true, modelCalls: 2, secondAsk: { suggested: 0, read: 0 }, rejected: { needs_page: 2 } });
    expect(out.summary.floor).toBeUndefined();
    expect(out.summary.rung).toBeUndefined();
    // The best-scored candidate, with what its results page showed and no source named.
    expect(out.proposal).toMatchObject({ term: "housing grant consultant", checked: true, why: "Its readers ask this before they apply." });
    // Nothing is written until the owner says so.
    expect(tables.keywords).toHaveLength(0);
    expect(tables.calendar_entries).toHaveLength(0);
  });

  it("reads on past the usual twelve while every page is rejected, and plans a later one", async () => {
    const { db } = setup();
    const many = lettered(18);
    // The fifteenth is the first whose results articles win.
    const serp = vi.fn(async (t: string) => (t === "housing grant office o" ? articles(t) : providers(t)));
    const out = await planFirstLook(db, "ws1", { ...base(), ask: reply(many), serp });
    expect(out.outcome).toBe("planned");
    expect(out.plan.map((p) => p.term)).toEqual(["housing grant office o"]);
    expect(serp.mock.calls.length).toBeGreaterThan(MAX_RESULTS_READS);
    expect(out.summary.rung).toBe("extended");
    expect(out.summary.extendedReads).toBeGreaterThan(0);
    // It stops at the round that accepted one: the last two are never bought.
    expect(serp.mock.calls.length).toBe(16);
    expect(out.reads).toHaveLength(16);
    expect(out.reads.find((r) => r.query === "housing grant office o")).toMatchObject({ verdict: "accepted", source: "suggested", type: "editorial" });
    expect(out.reads[0]).toMatchObject({ verdict: "needs_page" });
    expect(out.reads[0].results[0]).toMatchObject({ rank: 1, page: "service_or_local" });
  });

  it("keeps the cap of twelve once something is accepted", async () => {
    hold.mockResolvedValue("open");
    const { db } = setup();
    const serp = vi.fn(async (t: string) => (t === "housing grant office a" ? articles(t) : providers(t)));
    const out = await planFirstLook(db, "ws1", { ...base(), maxEntries: 5, ask: reply(lettered(20)), serp });
    expect(out.plan.map((p) => p.term)).toEqual(["housing grant office a"]);
    expect(serp.mock.calls.length).toBe(MAX_RESULTS_READS);
    expect(out.summary.rung).toBe("ranked");
    expect(out.summary.extendedReads).toBeUndefined();
  });

  it("makes a second ask for question searches when every suggestion was read and rejected, and plans from it", async () => {
    const { db, tables } = setup();
    const second = [topic("how to choose a housing grant consultant", { fit: 4 }), topic("housing grant consultant", { fit: 5 })];
    const ask = replies([topic("housing grant consultant", { fit: 5 }), topic("housing grant agency")], second);
    const serp = vi.fn(async (t: string) => (t.startsWith("how to") ? articles(t) : providers(t)));
    const out = await planFirstLook(db, "ws1", { ...base(), ask, serp });
    expect(out.outcome).toBe("planned");
    expect(out.plan.map((p) => p.term)).toEqual(["how to choose a housing grant consultant"]);
    expect(out.summary).toMatchObject({ rung: "second_ask", modelCalls: 2, secondAsk: { suggested: 2, read: 1 } });
    // A search already tried is not read again.
    expect(serp.mock.calls.filter(([t]) => t === "housing grant consultant")).toHaveLength(1);
    // The second prompt is built from the profile and names what was tried.
    const [operation, prompt] = ask.mock.calls[1] as [string, string];
    expect(operation).toBe("keyword-research/first-look-second-ask");
    expect(prompt).toContain("- scheme guides");
    expect(prompt).toContain("- housing grant consultant");
    const row = tables.keywords.find((r) => r.term === "how to choose a housing grant consultant")!;
    expect(readOpportunity(row.opportunity, FINGERPRINT)).toMatchObject({ status: "qualified", rung: "second_ask" });
    expect(out.asked.secondAsk.map((t) => t.query)).toEqual(second.map((t) => t.query));
    expect(out.reads.at(-1)).toMatchObject({ source: "second_ask", verdict: "accepted" });
  });

  it("does not make the second ask with the deadline close, the budget refusing pages, or the results provider down", async () => {
    const first = [topic("housing grant consultant"), topic("housing grant agency")];
    // Too little time left for a model call: straight to what it has.
    const late = replies(first, [topic("how to choose a housing grant consultant")]);
    const soon = await planFirstLook(setup().db, "ws1", { ...base(), firstLook: { serps: new Map(), deadline: Date.now() + 5_000 }, ask: late, serp: async (t) => providers(t) });
    expect(late).toHaveBeenCalledTimes(1);
    expect(soon.outcome).toBe("needs_owner_input");
    // The budget refused a page: nothing more is bought, and the unread topic is still proposed.
    const refused = replies(first, [topic("how to choose a housing grant consultant")]);
    const broke = await planFirstLook(setup().db, "ws1", { ...base(), ask: refused, serp: async () => { throw new BudgetRefusedError("a results page", "results_pages", 0.004); } });
    expect(refused).toHaveBeenCalledTimes(1);
    expect(broke.outcome).toBe("needs_owner_input");
    expect(broke.summary).toMatchObject({ stopped: "budget", resultsRead: 0, resultsFailed: 0 });
    expect(broke.proposal).toMatchObject({ checked: false });
    // The results provider answered nothing: ours, and the overnight retry's.
    const down = replies(first, [topic("how to choose a housing grant consultant")]);
    const outage = await planFirstLook(setup().db, "ws1", { ...base(), ask: down, serp: async () => { throw new Error("DataForSEO 402"); } });
    expect(down).toHaveBeenCalledTimes(1);
    expect(outage.outcome).toBe("provider");
  });

  it("plans a question search with nothing of its own to cite on a related search's article: the last floor", async () => {
    const { db, tables } = setup();
    // Both pages are providers' pages; only the non-question one has an article in it.
    const ask = replies([topic("housing grant consultant fees", { fit: 4 }), topic("how much are housing grant consultant fees", { fit: 4 })], []);
    const serp = async (t: string) => (t === "housing grant consultant fees" ? crowded(t) : providers(t));
    const out = await planFirstLook(db, "ws1", { ...base(), ask, serp });
    expect(out.outcome).toBe("planned");
    // The question leads the floor, though it has nothing of its own to cite.
    expect(out.plan.map((p) => p.term)).toEqual(["how much are housing grant consultant fees"]);
    expect(out.summary).toMatchObject({ floor: true, rung: "related_evidence", planned: 1 });
    const brief = readOpportunity(tables.keywords[0].opportunity, FINGERPRINT)!;
    expect(brief).toMatchObject({ confidence: "lower", evidenceFrom: "housing grant consultant fees", rung: "related_evidence" });
    expect(brief.evidenceUrls).toEqual(["https://news-8.example/blog/housing-grant-consultant-fees"]);
    expect(brief.reason).toMatch(/related search/);
  });

  it("never reads more than every suggestion and the second ask's", async () => {
    const serp = vi.fn(async (t: string) => providers(t));
    const out = await planFirstLook(setup().db, "ws1", { ...base(), ask: replies(lettered(20), lettered(12, { kind: "question" }).map((t, i) => ({ ...t, query: `how to pick housing grant office ${i}` }))), serp });
    expect(serp.mock.calls.length).toBeLessThanOrEqual(HARD_MAX_READS);
    expect(serp.mock.calls.length).toBe(28);
    expect(out.outcome).toBe("needs_owner_input");
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
    // A first reply with no whole topic falls to the second ask before it is called unreadable.
    const rescued = await planFirstLook(setup().db, "ws1", { ...base(), ask: replies('{"topics": [{"query": "housing', [topic("how to apply for the housing grant")]), serp: async (t) => articles(t) });
    expect(rescued.outcome).toBe("planned");
    expect(rescued.summary).toMatchObject({ suggested: 0, rung: "second_ask", modelCalls: 2 });
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
