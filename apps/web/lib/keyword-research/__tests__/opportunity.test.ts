import { beforeEach, describe, expect, it, vi } from "vitest";
const { ask, judge, fetchSerp, available } = vi.hoisted(() => ({ ask: vi.fn(), judge: vi.fn(), fetchSerp: vi.fn(), available: vi.fn(() => true) }));
vi.mock("../buyer-model", async (original) => ({ ...await original<object>(), modelAvailable: available, askStructured: ask }));
vi.mock("../buyer-fit", async (original) => ({ ...await original<object>(), judgeBuyerFit: judge }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: available }));
vi.mock("@/lib/seo/brief-data", () => ({ fetchAdvancedSerp: fetchSerp }));
import { askedKey } from "../buyer-fit";
import { opportunitySchema, qualifyOpportunities, readOpportunity, contextKey, validArticleAngle, assertAutonomousTopic, summarizeQualification, type Opportunity } from "../opportunity";
import { sameIntent, sharedResults } from "../intent";
import { claimSpend, withSpendScope, type RunBudget } from "@/lib/billing/spend-scope";
import { balanceSources, diverseSeeds } from "../diversity";

const context = { domain: "example.com", languageCode: "it", locationCode: 2380, business: { name: "Clinic Studio", description: "Clinic Studio builds booking websites for clinics and salons at a fixed price.", offerings: ["clinic booking websites"], audiences: ["clinic owners"] } };
const term = "clinic booking website costs";
const urls = ["https://one.test/guide", "https://two.test/guide", "https://three.test/guide", "https://four.test/guide"];
const approval = { stage: "comparing", kinds: ["article", "article", "article", "article"], reason: "Clinic owners compare the cost of a booking website", audience: "clinic owners", buyingJob: "choose a booking website", offering: "clinic booking websites", angle: "What clinics should budget for a booking website", conversionPath: "https://example.com/contact" };
/** How many results the judge was shown, read back from its prompt. */
const shown = (prompt: string) => (JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as { results: unknown[] }).results.length;
/** The judge names every result `kinds` (one word for all, or one each), with the approval's brief. */
const answerWith = (kinds: string | string[], extra: Record<string, unknown> = {}) =>
  ask.mockImplementation(async (_op: string, prompt: string) => JSON.stringify({ ...approval, ...extra, kinds: Array.isArray(kinds) ? kinds : Array(shown(prompt)).fill(kinds) }));
/** Results pages as `fetchAdvancedSerp` returns them. */
const serpOf = (pages: Array<{ url: string; title: string; description?: string }>) => ({ organic: pages.map((p, i) => ({ description: "", ...p, rank: i + 1 })), peopleAlsoAsk: [], aiOverview: null });
const productPages = serpOf(["https://vendor-one.test/", "https://vendor-two.test/pricing", "https://vendor-three.test/", "https://vendor-four.test/features"].map((url) => ({ url, title: "Clinic booking websites | Book a demo" })));
const toolPages = serpOf([{ url: "https://apps.apple.com/app/clinic-booking", title: "Clinic Booking on the App Store" }, { url: "https://play.google.com/store/apps/clinic-booking", title: "Clinic booking website app" }, { url: "https://www.udemy.com/course/clinic-booking-website", title: "Build a clinic booking website course" }, { url: "https://github.com/x/clinic-booking-website", title: "clinic booking website template" }]);
const writes: unknown[] = [];
let covered: unknown[] = [];
let articles: unknown[] = [];
let spendRows: unknown[] = [];
const db = { from: (table: string) => ({ select: (_columns?: string, options?: { count?: string }) => { const rows = table === "keywords" ? covered : table === "articles" ? articles : table === "provider_spend" ? spendRows : []; const q: Record<string, unknown> = { eq: () => q, in: () => q, not: () => q, neq: () => q, gte: () => q, order: () => q, range: () => q, maybeSingle: async () => ({ data: table === "workspaces" ? { account_id: "acc", status: "active", paused_until: null } : null, error: null }), then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null, count: options?.count ? rows.length : null }) }; return q; }, update: (row: unknown) => { writes.push(row); const q = { eq: () => q, then: (resolve: (v: unknown) => unknown) => resolve({error:null}) }; return q; } }), auth: { getUser: async () => ({ data: { user: null } }) } } as never;
beforeEach(() => {
  vi.clearAllMocks(); writes.length = 0; covered = []; articles = []; spendRows = []; available.mockReturnValue(true);
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
    expect(result).toMatchObject({status:"qualified",audience:approval.audience,angle:approval.angle,format:"article",evidenceUrls:urls});
    expect(fetchSerp).toHaveBeenCalledWith(term, context);
  });
  it("cites only observed editorial results, whatever the model names", async () => {
    answerWith("article", { evidenceUrls: ["https://invented.test/a", "https://invented.test/b"] });
    const result = await run();
    expect(result.status).toBe("qualified");
    expect(result.evidenceUrls).toEqual(urls);
  });
  it("does not treat a tool-dominated search as an approved article: the kinds the judge names decide", async () => {
    fetchSerp.mockResolvedValue(toolPages);
    answerWith("tool");
    expect(await run()).toMatchObject({ status: "rejected", cause: "not_editorial" });
  });
  it("asks the judge as a decision, with its reply held to the schema", async () => {
    await run();
    expect(ask).toHaveBeenCalledWith("keyword-research/opportunity", expect.any(String), expect.objectContaining({ tier: "decision", schema: opportunitySchema() }));
  });
  it("rejects a searcher the business does not serve, from the stage the model names", async () => {
    ask.mockResolvedValue(JSON.stringify({ stage: "practitioner", reason: "a developer learning to build booking sites" }));
    expect(await run()).toMatchObject({ status: "rejected", cause: "buyer_mismatch" });
  });
  it("keeps a problem-aware searcher, labelled top of funnel", async () => {
    answerWith("article", { stage: "problem" });
    expect(await run()).toMatchObject({ status: "qualified", funnel: "audience" });
  });
  it("leaves an answer with no stage pending", async () => {
    ask.mockResolvedValue(JSON.stringify({ ...approval, stage: undefined, approve: true }));
    expect(await run()).toMatchObject({ status: "pending", cause: "judge_incomplete" });
  });
  it("reads the answer after reasoning the model wrote into its reply", async () => {
    ask.mockResolvedValue(`<think>\n1. {"stage": maybe [hiring]}\n</think>\n${JSON.stringify(approval)}`);
    expect((await run()).status).toBe("qualified");
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
    // Rejected, so the refill parks it; for 30 days, not for good (queue.ts).
    expect(result).toMatchObject({ status: "rejected", cause: "thin_serp" });
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
    fetchSerp.mockResolvedValue(toolPages);
    answerWith("tool");
    expect(await run()).toMatchObject({ status: "rejected", cause: "not_editorial" });
    fetchSerp.mockResolvedValue(productPages);
    answerWith("product");
    expect(await run()).toMatchObject({ status: "rejected", cause: "needs_page" });
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
    answerWith("article", { shape: "comparison" });
    const out = await run();
    expect(out.status).toBe("qualified");
    expect(out.shape).toBe("comparison");
  });
  it("ignores a shape outside the taxonomy", async () => {
    answerWith("article", { shape: "poem" });
    expect((await run()).shape).toBeUndefined();
  });
  it("says a search wants a landing page when most results are product pages: the kinds decide, not a format word", async () => {
    fetchSerp.mockResolvedValue(productPages);
    answerWith("product", { format: "article" });
    const out = await run();
    expect(out.status).toBe("rejected");
    expect(out.cause).toBe("needs_page");
    expect(out.reason).toContain("landing page");
  });
  it("counts shop and category pages as products even where their URLs look like guides (no word lists for Italian)", async () => {
    // Six shop category pages whose paths read like articles, four guides:
    // the word lists would have called nine of ten editorial.
    fetchSerp.mockResolvedValue(serpOf([
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ url: `https://shop${i}.test/caldaie-condensazione-guida-${i}`, title: "Caldaie a condensazione: come scegliere" })),
      ...[1, 2, 3, 4].map((i) => ({ url: `https://guide${i}.test/blog/caldaie-condensazione`, title: "Caldaie a condensazione: cosa sono" })),
    ]));
    const boilers = "caldaie a condensazione";
    judge.mockResolvedValue({ basis: "model", verdicts: new Map([[boilers, { keep: true, reason: "a homeowner choosing a boiler" }]]) });
    const runBoilers = async () => (await qualifyOpportunities(db, "ws", [{ id: "k", term: boilers }], context)).get("k");
    answerWith([...Array(6).fill("product"), ...Array(4).fill("article")]);
    expect(await runBoilers()).toMatchObject({ status: "rejected", cause: "needs_page" });
    answerWith([...Array(4).fill("product"), ...Array(6).fill("article")]);
    expect(await runBoilers()).toMatchObject({ status: "qualified", format: "mixed" });
  });
  it("counts an article the judge names as off-topic when it carries none of the phrase's words", async () => {
    // A phrase nobody writes about (a made-up compound name) comes back as
    // other people's unrelated articles; the judge's generous "article" is
    // checked against the words, as the word lists' reading is.
    const compound = "zentrocrm alternatives";
    judge.mockResolvedValue({ basis: "model", verdicts: new Map([[compound, { keep: true, reason: "comparing" }]]) });
    fetchSerp.mockResolvedValue(serpOf([
      { url: "https://news.test/blog/zen-garden", title: "Zen gardens for beginners" },
      { url: "https://crm.test/blog/what-is-crm", title: "What is a CRM?" },
      { url: "https://field.test/blog/field-guide", title: "A field guide to birds" },
      { url: "https://zentrocrm.test/", title: "Zentrocrm - the CRM for studios" },
    ]));
    answerWith("article");
    const out = (await qualifyOpportunities(db, "ws", [{ id: "k", term: compound }], context)).get("k");
    expect(out).toMatchObject({ status: "rejected", cause: "not_editorial" });
    expect(out?.reason).toContain("not about this search");
    expect(out?.floor).toBeUndefined();
  });
  it("reads the results from the word lists when the judge names no kinds in a language they cover, and says so", async () => {
    ask.mockResolvedValue(JSON.stringify({ ...approval, kinds: undefined }));
    fetchSerp.mockResolvedValue(serpOf(urls.map((url) => ({ url: url.replace("/guide", "/blog/clinic-booking-website-cost-guide"), title: "How much does a clinic booking website cost?" }))));
    const en = await qualifyOpportunities(db, "ws", [{ id: "k", term }], { ...context, languageCode: "en" });
    expect(en.get("k")).toMatchObject({ status: "qualified" });
    expect(en.get("k")?.reason).toContain("read from URLs and titles");
    expect(await run()).toMatchObject({ status: "pending", cause: "judge_incomplete" });
  });
  it("refuses a phrase naming a known rival without asking the judge", async () => {
    const withRival = { ...context, business: { ...context.business, competitors: ["bookwell.test"] } };
    judge.mockResolvedValue({ basis: "model", verdicts: new Map([["bookwell login", { keep: true, reason: "a clinic owner" }]]) });
    const out = (await qualifyOpportunities(db, "ws", [{ id: "k", term: "bookwell login" }], withRival)).get("k");
    expect(out).toMatchObject({ status: "rejected", cause: "buyer_mismatch" });
    expect(ask).not.toHaveBeenCalled();
    judge.mockResolvedValue({ basis: "model", verdicts: new Map([["bookwell alternatives", { keep: true, reason: "comparing" }]]) });
    fetchSerp.mockResolvedValue(serpOf(urls.map((url) => ({ url, title: "Bookwell alternatives for clinics" }))));
    expect((await qualifyOpportunities(db, "ws", [{ id: "k", term: "bookwell alternatives" }], withRival)).get("k")?.status).toBe("qualified");
  });
  it("leaves a phrase built from generic words to the judge, even when a rival's domain is those words run together", async () => {
    // A local rival's domain is often a service plus a city: the site's own
    // core search "<service> <city>" must not read as that business's name.
    const withRival = { ...context, business: { ...context.business, competitors: ["clinicbookingwebsite.test", "booking.test"] } };
    judge.mockResolvedValue({ basis: "model", verdicts: new Map([[term, { keep: true, reason: "a clinic owner" }]]) });
    expect((await qualifyOpportunities(db, "ws", [{ id: "k", term }], withRival)).get("k")?.status).toBe("qualified");
    expect(ask).toHaveBeenCalled();
  });
  it("keeps the brief on a thin editorial page a served searcher asks about, for the planner's floor", async () => {
    answerWith(["article", "tool", "service", "offtopic"]);
    const out = await run();
    expect(out).toMatchObject({ status: "rejected", cause: "not_editorial", floor: true, angle: approval.angle, evidenceUrls: [urls[0]] });
    answerWith("tool");
    expect((await run()).floor).toBeUndefined();
  });
  it("keeps no floor brief on a page of tools or portals, one mostly off-topic, or a phrase naming a rival", async () => {
    answerWith(["article", "tool", "tool", "portal"]);
    expect(await run()).toMatchObject({ status: "rejected", cause: "not_editorial" });
    expect((await run()).floor).toBeUndefined();
    answerWith(["article", "offtopic", "offtopic", "offtopic"]);
    expect((await run()).floor).toBeUndefined();
    const withRival = { ...context, business: { ...context.business, competitors: ["bookwell.test"] } };
    const named = "bookwell alternatives";
    judge.mockResolvedValue({ basis: "model", verdicts: new Map([[named, { keep: true, reason: "comparing" }]]) });
    fetchSerp.mockResolvedValue(serpOf(urls.map((url) => ({ url, title: "Bookwell alternatives for clinics" }))));
    answerWith(["article", "tool", "service", "offtopic"]);
    const out = (await qualifyOpportunities(db, "ws", [{ id: "k", term: named }], withRival)).get("k");
    expect(out).toMatchObject({ status: "rejected", cause: "not_editorial" });
    expect(out?.floor).toBeUndefined();
  });
  it("sends a searcher ready to hire to a landing page when providers' pages crowd the results", async () => {
    fetchSerp.mockResolvedValue(serpOf([...urls.map((url) => ({ url, title: "Clinic booking website cost guide" })), ...productPages.organic]));
    answerWith([...Array(4).fill("article"), ...Array(4).fill("product")], { stage: "hiring" });
    expect((await run()).cause).toBe("needs_page");
    answerWith([...Array(4).fill("article"), ...Array(4).fill("product")], { stage: "comparing" });
    expect(await run()).toMatchObject({ status: "qualified", format: "mixed" });
  });
});

describe("a first look", () => {
  const firstLook = { runId: "run-1" };
  const look = async (extra = {}) => (await qualifyOpportunities(db, "ws", [{ id: "k", term, ...extra }], context, { firstLook })).get("k");
  it("approves only when two reads of the results page agree", async () => {
    answerWith("article");
    expect(await look()).toMatchObject({ status: "qualified" });
    expect(ask).toHaveBeenCalledTimes(2);
  });
  it("keeps a refusing second read, marked contested, and says both", async () => {
    let calls = 0;
    ask.mockImplementation(async (_op: string, prompt: string) => JSON.stringify({ ...approval, kinds: Array(shown(prompt)).fill(calls++ === 0 ? "article" : "service") }));
    const out = await look();
    expect(out).toMatchObject({ status: "rejected", cause: "needs_page", contested: true });
    expect(out?.reason).toMatch(/^Two reads of this results page disagreed/);
  });
  it("keeps the approval when the second read returned nothing usable", async () => {
    let calls = 0;
    ask.mockImplementation(async (_op: string, prompt: string) => (calls++ === 0 ? JSON.stringify({ ...approval, kinds: Array(shown(prompt)).fill("article") }) : null));
    expect(await look()).toMatchObject({ status: "qualified" });
  });
  it("asks once outside a first look", async () => {
    answerWith("article");
    await run();
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it("reuses the buyer verdict discovery saved for the same question, and asks for the rest", async () => {
    const business = { ...context.business, language: context.languageCode };
    const saved = { keep: true, reason: "a clinic owner", funnel: "buyer", asked: askedKey(business) };
    answerWith("article");
    expect(await run({ buyer_fit: saved })).toMatchObject({ status: "qualified" });
    expect(judge).not.toHaveBeenCalled();
    await run({ buyer_fit: { ...saved, asked: "fit1-other" } });
    expect(judge).toHaveBeenCalledTimes(1);
  });
  describe("under the run's budget", () => {
    // A budget that grants the first `grants` claims and refuses the rest.
    // The mocked paid edges claim the way the real ones do (lib/seo/client.ts
    // post, buyer-model askStructured): a results page throws the refusal, a
    // model read answers null.
    const budgetOf = (grants: number): RunBudget & { claims: string[] } => {
      const claims: string[] = [];
      return { runId: "run-1", claims, claim: async (stage) => { claims.push(stage); return claims.length <= grants ? 0.01 : null; }, settle: async () => {}, room: async () => null };
    };
    const lookIn = (budget: RunBudget) => withSpendScope({ budget }, () => look());
    beforeEach(() => {
      const page = { organic: urls.map((url, i) => ({ url, title: "Clinic booking website cost guide", description: "A buyer guide", rank: i + 1 })), peopleAlsoAsk: [], aiOverview: null };
      fetchSerp.mockImplementation(async () => { await claimSpend("/serp/google/organic/live/advanced", 0.004); return page; });
      const reply = JSON.stringify({ ...approval, kinds: Array(urls.length).fill("article") });
      ask.mockImplementation(async () => (await claimSpend("keyword-research/opportunity", 0.02).then(() => reply, () => null)));
      judge.mockImplementation(async () => { const ok = await claimSpend("keyword-research/buyer-fit", 0.05).then(() => true, () => false); return { basis: "model", verdicts: ok ? new Map([[term, { keep: true, reason: "specific buyer need" }]]) : new Map() }; });
    });
    it("judges as before while the budget covers every read, each tagged by its stage", async () => {
      const budget = budgetOf(10);
      expect(await lookIn(budget)).toMatchObject({ status: "qualified" });
      expect(budget.claims).toEqual(["buyer_fit", "results_pages", "judge", "judge"]);
    });
    it("leaves a term not judged when its results page is refused: no verdict saved, nothing parked", async () => {
      expect(await lookIn(budgetOf(1))).toBeUndefined();
      expect(ask).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });
    it("leaves a term not judged when the judge's read is refused, rather than saving 'unusable answer'", async () => {
      expect(await lookIn(budgetOf(2))).toBeUndefined();
      expect(writes).toEqual([]);
    });
    it("leaves the batch not judged when the buyer test is refused, rather than saving 'no decision'", async () => {
      expect(await lookIn(budgetOf(0))).toBeUndefined();
      expect(fetchSerp).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });
    it("keeps a first approval whose second read was refused: a refusal is no answer, not a no", async () => {
      expect(await lookIn(budgetOf(3))).toMatchObject({ status: "qualified" });
    });
  });
});
