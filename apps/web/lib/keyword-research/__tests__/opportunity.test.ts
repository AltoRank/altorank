import { beforeEach, describe, expect, it, vi } from "vitest";
const { ask, judge, fetchSerp, available } = vi.hoisted(() => ({ ask: vi.fn(), judge: vi.fn(), fetchSerp: vi.fn(), available: vi.fn(() => true) }));
vi.mock("../buyer-model", async (original) => ({ ...await original<object>(), modelAvailable: available, askStructured: ask }));
vi.mock("../buyer-fit", async (original) => ({ ...await original<object>(), judgeBuyerFit: judge }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: available }));
vi.mock("@/lib/seo/brief-data", () => ({ fetchAdvancedSerp: fetchSerp }));
import { qualifyOpportunities, readOpportunity, contextKey, validArticleAngle, assertAutonomousTopic, summarizeQualification, type Opportunity } from "../opportunity";
import { sameIntent, sharedResults } from "../intent";
import { balanceSources, diverseSeeds } from "../diversity";

const context = { domain: "example.com", languageCode: "it", locationCode: 2380, business: { name: "Clinic Studio", description: "Clinic Studio builds booking websites for clinics and salons at a fixed price.", offerings: ["clinic booking websites"], audiences: ["clinic owners"] } };
const term = "clinic booking website costs";
const urls = ["https://one.test/guide", "https://two.test/guide", "https://three.test/guide", "https://four.test/guide"];
const approval = { approve: true, reason: "Clinic owners compare the cost of a booking website", audience: "clinic owners", buyingJob: "choose a booking website", offering: "clinic booking websites", angle: "What clinics should budget for a booking website", format: "article", conversionPath: "https://example.com/contact", evidenceUrls: urls.slice(0, 2) };
const writes: unknown[] = [];
let covered: unknown[] = [];
let articles: unknown[] = [];
const db = { from: (table: string) => ({ select: () => { const rows = table === "keywords" ? covered : table === "articles" ? articles : []; const q: Record<string, unknown> = { eq: () => q, in: () => q, not: () => q, neq: () => q, gte: () => q, order: () => q, range: () => q, maybeSingle: async () => ({ data: table === "workspaces" ? { account_id: "acc", status: "active", paused_until: null } : null, error: null }), then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }) }; return q; }, update: (row: unknown) => { writes.push(row); const q = { eq: () => q, then: (resolve: (v: unknown) => unknown) => resolve({error:null}) }; return q; } }), auth: { getUser: async () => ({ data: { user: null } }) } } as never;
beforeEach(() => {
  vi.clearAllMocks(); writes.length = 0; covered = []; articles = []; available.mockReturnValue(true);
  judge.mockResolvedValue({ basis: "model", verdicts: new Map([[term, {keep:true,reason:"specific buyer need"}]]) });
  fetchSerp.mockResolvedValue({ organic: urls.map((url, i) => ({url,title:"Clinic booking website cost guide",description:"A buyer guide",rank:i+1})), peopleAlsoAsk:[],aiOverview:null });
  ask.mockResolvedValue(JSON.stringify(approval));
});
async function run(extra = {}) { return (await qualifyOpportunities(db, "ws", [{id:"k",term,...extra}], context)).get("k")!; }

describe("topic qualification", () => {
  it("shares cached evidence across callers and JSONB field orders", () => {
    expect(contextKey(context)).toBe(contextKey({ business: { audiences: context.business.audiences, offerings: context.business.offerings, description: context.business.description, name: context.business.name }, locationCode: context.locationCode, languageCode: context.languageCode, domain: context.domain }));
  });
  it("keeps browser fixture approvals isolated from real domains and databases", async () => {
    vi.stubEnv("E2E_STUBS", "1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54331");
    available.mockReturnValue(false);
    try {
      expect(await run()).toBeUndefined(); // Real example.com, not a reserved TLD.
      const fixtureContext = { ...context, domain: "fixture.altorank.test" };
      expect((await qualifyOpportunities(db, "ws", [{ id: "k", term }], fixtureContext)).get("k")?.status).toBe("qualified");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
      expect((await qualifyOpportunities(db, "ws", [{ id: "k", term }], fixtureContext)).size).toBe(0);
      expect(ask).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it("does not repeat an intent already planned in an earlier batch", async () => {
    const approved = await run();
    covered = [{ id: "earlier", term: "price of a clinic website", status: "planned", opportunity: approved }];
    expect(await run({ opportunity: approved })).toMatchObject({ status: "rejected", cause: "duplicate", duplicateOf: "earlier", duplicateTerm: "price of a clinic website", intentBasis: "serp" });
    covered = [{ id: "k", term, status: "planned", opportunity: approved }];
    expect((await run({ opportunity: approved })).status).toBe("qualified");
  });
  it("compares against a drafted topic whose verdict has expired or was bought under another profile", async () => {
    // The owner's results page is a measured fact about its search; the
    // verdict's age and context do not change which search it was.
    const approved = await run();
    covered = [{ id: "old", term: "clinic website price guide", status: "drafting", opportunity: { ...approved, context: "another-profile", checkedAt: "2026-01-01T00:00:00.000Z" } }];
    expect(await run({ opportunity: approved })).toMatchObject({ status: "rejected", cause: "duplicate", duplicateOf: "old" });
    expect((await run({ opportunity: approved })).reason).toContain("already drafted");
  });
  it("is refused by an article with no keyword row when the words are the same, and says it compared words", async () => {
    const approved = await run();
    articles = [{ id: "a1", keyword: "Clinic booking website cost", keyword_id: null, status: "live" }];
    const out = await qualifyOpportunities(db, "ws", [{ id: "k", term, opportunity: approved }], { ...context, languageCode: "en" });
    expect(out.get("k")).toMatchObject({ status: "rejected", cause: "duplicate", duplicateTerm: "Clinic booking website cost", intentBasis: "words" });
    expect(out.get("k")?.duplicateOf).toBeUndefined();
    // Italian has no rule set: the same pair is compared by exact words, and
    // "cost"/"costs" are not folded - kept apart, never stemmed as English.
    expect((await run({ opportunity: approved })).status).toBe("qualified");
  });
  it("refuses an obsolete year copied into an evergreen headline", async () => {
    ask.mockResolvedValue(JSON.stringify({ ...approval, angle: "Clinic website costs in 2025" }));
    expect((await run()).status).toBe("pending");
    expect(validArticleAngle("Clinic website costs in 2025", "clinic website costs 2025")).toBe(true);
    expect(validArticleAngle("x".repeat(161), term)).toBe(false);
  });
  it("requires a positive buyer decision; omissions remain pending", async () => {
    judge.mockResolvedValue({basis:"model",verdicts:new Map()});
    expect((await run()).status).toBe("pending");
    expect(fetchSerp).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });
  it("rejects an explicit buyer mismatch without buying SERP evidence", async () => {
    judge.mockResolvedValue({basis:"model",verdicts:new Map([[term,{keep:false,reason:"student homework"}]])});
    expect((await run()).status).toBe("rejected"); expect(fetchSerp).not.toHaveBeenCalled();
  });
  it("records an article's buyer, angle, observed sources and correct market", async () => {
    const result = await run();
    expect(result).toMatchObject({status:"qualified",audience:approval.audience,angle:approval.angle,evidenceUrls:urls.slice(0,2)});
    expect(fetchSerp).toHaveBeenCalledWith(term, context);
  });
  it("does not accept invented evidence URLs", async () => {
    ask.mockResolvedValue(JSON.stringify({...approval,evidenceUrls:["https://invented.test/a","https://invented.test/b"]}));
    expect((await run()).status).toBe("pending");
  });
  it("does not treat a tool-dominated search as an approved article", async () => {
    ask.mockResolvedValue(JSON.stringify({...approval,format:"tool"}));
    // Not pending any more: the answer is known, and it is a page, not an article.
    expect(await run()).toMatchObject({ status: "rejected", cause: "needs_page" });
  });
  it("routes existing own-page targets to review instead of a new blog", async () => {
    const result = await run({source_url:"https://www.example.com/booking"});
    expect(result).toMatchObject({status:"rejected",existingUrl:"https://www.example.com/booking"});
    expect(ask).not.toHaveBeenCalled();
  });
  it("recognises the site's own result when its URL carries a query string", async () => {
    // A canonical page keeps the query that names it ("?lang=it"); the host
    // is still the site's own.
    const own = "https://www.example.com/?lang=it";
    fetchSerp.mockResolvedValue({ organic: [own, ...urls].map((url, i) => ({ url, title: "Clinic booking website cost guide", description: "A buyer guide", rank: i + 1 })), peopleAlsoAsk: [], aiOverview: null });
    expect(await run()).toMatchObject({ status: "rejected", cause: "existing_page", existingUrl: own });
  });
  it("caches valid evidence but invalidates it when the business changes", async () => {
    const result = await run(); vi.clearAllMocks();
    expect((await run({opportunity:result})).status).toBe("qualified");
    expect(fetchSerp).not.toHaveBeenCalled();
    expect(readOpportunity(result, contextKey({...context,languageCode:"en"}))).toBeNull();
  });
  it("does not consider malformed saved approvals valid", () => {
    expect(readOpportunity({version:1,context:contextKey(context),status:"qualified",checkedAt:new Date().toISOString()},contextKey(context))).toBeNull();
  });
  it("leaves failed provider calls pending, and says which call failed", async () => {
    fetchSerp.mockRejectedValue(new Error("provider unavailable"));
    const result = await run();
    expect(result.status).toBe("pending");
    expect(result.cause).toBe("provider_error");
    expect(result.reason).toContain("provider unavailable");
  });
  it("names a missing buyer decision as the cause, not a vague failure", async () => {
    judge.mockResolvedValue({basis:"model",verdicts:new Map()});
    const result = await run();
    expect(result).toMatchObject({ status: "pending", cause: "no_verdict" });
    expect(result.reason).not.toContain("could not be confirmed");
  });
  it("names a thin search page as the cause", async () => {
    fetchSerp.mockResolvedValue({ organic: urls.slice(0, 2).map((url, i) => ({url,title:"t",description:"d",rank:i+1})), peopleAlsoAsk:[], aiOverview:null });
    const result = await run();
    expect(result).toMatchObject({ status: "pending", cause: "thin_serp" });
    expect(ask).not.toHaveBeenCalled();
  });
  it("without a business profile, stamps every term 'no profile' and buys nothing", async () => {
    // altorank.co and supalabs.co, 2026-09-14: sixty-four terms "pending:
    // buyer fit could not be confirmed", six nights running, because the
    // profile column was empty and nothing said so.
    const result = (await qualifyOpportunities(db, "ws", [{ id: "k", term }], { ...context, business: null })).get("k")!;
    expect(result).toMatchObject({ status: "pending", cause: "no_profile" });
    expect(result.reason).toContain("No business profile");
    expect(judge).not.toHaveBeenCalled();
    expect(fetchSerp).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });
  it("carries a cause on every rejection", async () => {
    judge.mockResolvedValue({basis:"model",verdicts:new Map([[term,{keep:false,reason:"student homework"}]])});
    expect(await run()).toMatchObject({ status: "rejected", cause: "buyer_mismatch" });
    judge.mockResolvedValue({ basis: "model", verdicts: new Map([[term, {keep:true,reason:"specific buyer need"}]]) });
    ask.mockResolvedValue(JSON.stringify({ ...approval, approve: false, reason: "product pages only" }));
    expect(await run()).toMatchObject({ status: "rejected", cause: "not_editorial" });
    expect(await run({source_url:"https://www.example.com/booking"})).toMatchObject({ status: "rejected", cause: "existing_page" });
  });
  it("sums the verdicts into one line for the run log", () => {
    const o = (status: Opportunity["status"], cause?: Opportunity["cause"]): Opportunity => ({ version: 2, context: "c", checkedAt: "now", status, reason: "r", cause });
    expect(summarizeQualification([])).toBeNull();
    expect(summarizeQualification([undefined, null])).toBeNull();
    expect(summarizeQualification([o("qualified"), o("rejected", "buyer_mismatch"), o("rejected", "buyer_mismatch"), o("pending", "no_profile"), o("pending", "thin_serp"), o("pending", "no_profile")]))
      .toBe("1 qualified, 2 rejected (2 not a buyer search), 3 pending (2 no business profile, 1 too few search results)");
  });
  it("does not invent approval when providers are unavailable", async () => {
    available.mockReturnValue(false);
    expect(await run()).toBeUndefined(); expect(judge).not.toHaveBeenCalled();
  });
  it("refuses autonomous generation without a tracked keyword", async () => {
    const q = {eq:()=>q,maybeSingle:async()=>({data:null})};
    await expect(assertAutonomousTopic({from:()=>({select:()=>q})} as never,"ws",term,context)).rejects.toThrow("tracked, qualified");
  });
});
describe("candidate diversity", () => {
  it("reserves source coverage when existing rankings are numerous", () => {
    const rows = [...Array.from({length:500},(_,i)=>({source:0,id:i})),{source:1,id:501},{source:2,id:502}];
    expect(balanceSources(rows,r=>r.source).slice(0,3).map(r=>r.source)).toEqual([0,1,2]);
  });
  it("uses another seed instead of a word-order variant", () => {
    expect(diverseSeeds(["seo content software","content seo software","clinic website cost"],2)).toEqual(["seo content software","clinic website cost"]);
  });
  it("recognizes SERP overlap without inventing overlap from sparse responses", () => {
    expect(sharedResults(urls,[...urls.slice(0,2),"https://five.test/a"])).toBe(2);
    expect(sameIntent({ term: "clinic website costs", organicUrls: urls }, { term: "price of a clinic site", organicUrls: urls }, "en")).toMatchObject({ same: true, basis: "serp", shared: 4 });
    // Three URLs cannot reach the four-shared bar: the words decide, and say so.
    expect(sameIntent({ term: "clinic website costs", organicUrls: urls.slice(0, 3) }, { term: "price of a clinic site", organicUrls: urls.slice(0, 3) }, "en")).toMatchObject({ same: false, basis: "words" });
  });
});

describe("page-type decisions", () => {
  it("saves the shape the results page is won by", async () => {
    ask.mockResolvedValue(JSON.stringify({ ...approval, shape: "comparison" }));
    const out = await run();
    expect(out.status).toBe("qualified");
    expect(out.shape).toBe("comparison");
  });
  it("ignores a shape outside the taxonomy", async () => {
    ask.mockResolvedValue(JSON.stringify({ ...approval, shape: "poem" }));
    expect((await run()).shape).toBeUndefined();
  });
  it("says a search wants a landing page when the results are product or tool pages", async () => {
    ask.mockResolvedValue(JSON.stringify({ ...approval, approve: false, format: "tool", reason: "Results are app store and product pages." }));
    const out = await run();
    expect(out.status).toBe("rejected");
    expect(out.cause).toBe("needs_page");
    expect(out.reason).toContain("landing page");
  });
  it("does the same when the model approved but the results are product pages", async () => {
    ask.mockResolvedValue(JSON.stringify({ ...approval, format: "product" }));
    expect((await run()).cause).toBe("needs_page");
  });
});
