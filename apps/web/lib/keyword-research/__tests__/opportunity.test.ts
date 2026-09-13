import { beforeEach, describe, expect, it, vi } from "vitest";
const { ask, judge, fetchSerp, available } = vi.hoisted(() => ({ ask: vi.fn(), judge: vi.fn(), fetchSerp: vi.fn(), available: vi.fn(() => true) }));
vi.mock("../buyer-model", async (original) => ({ ...await original<object>(), modelAvailable: available, askStructured: ask }));
vi.mock("../buyer-fit", () => ({ judgeBuyerFit: judge }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: available }));
vi.mock("@/lib/seo/brief-data", () => ({ fetchAdvancedSerp: fetchSerp }));
import { qualifyOpportunities, readOpportunity, contextKey, serpOverlap, validArticleAngle, assertAutonomousTopic } from "../opportunity";
import { balanceSources, diverseSeeds } from "../diversity";

const context = { domain: "example.com", languageCode: "it", locationCode: 2380, business: { name: "Clinic Studio", offerings: ["clinic booking websites"], audiences: ["clinic owners"] } };
const term = "clinic booking website costs";
const urls = ["https://one.test/guide", "https://two.test/guide", "https://three.test/guide"];
const approval = { approve: true, reason: "Clinic owners compare the cost of a booking website", audience: "clinic owners", buyingJob: "choose a booking website", offering: "clinic booking websites", angle: "What clinics should budget for a booking website", format: "article", conversionPath: "https://example.com/contact", evidenceUrls: urls.slice(0, 2) };
const writes: unknown[] = [];
let covered: unknown[] = [];
const db = { from: () => ({ select: () => { const q = { eq: () => q, in: async () => ({ data: covered, error: null }) }; return q; }, update: (row: unknown) => { writes.push(row); const q = { eq: () => q, then: (resolve: (v: unknown) => unknown) => resolve({error:null}) }; return q; } }) } as never;
beforeEach(() => {
  vi.clearAllMocks(); writes.length = 0; covered = []; available.mockReturnValue(true);
  judge.mockResolvedValue({ basis: "model", verdicts: new Map([[term, {keep:true,reason:"specific buyer need"}]]) });
  fetchSerp.mockResolvedValue({ organic: urls.map((url, i) => ({url,title:"Clinic booking website cost guide",description:"A buyer guide",rank:i+1})), peopleAlsoAsk:[],aiOverview:null });
  ask.mockResolvedValue(JSON.stringify(approval));
});
async function run(extra = {}) { return (await qualifyOpportunities(db, "ws", [{id:"k",term,...extra}], context)).get("k")!; }

describe("topic qualification", () => {
  it("shares cached evidence across callers and JSONB field orders", () => {
    expect(contextKey(context)).toBe(contextKey({ business: { audiences: context.business.audiences, offerings: context.business.offerings, name: context.business.name }, locationCode: context.locationCode, languageCode: context.languageCode, domain: context.domain }));
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
    covered = [{ id: "earlier", term: "price of a clinic website", opportunity: approved }];
    expect(await run({ opportunity: approved })).toMatchObject({ status: "rejected", duplicateOf: "earlier" });
    covered = [{ id: "k", term, opportunity: approved }];
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
    expect((await run()).status).toBe("pending");
  });
  it("routes existing own-page targets to review instead of a new blog", async () => {
    const result = await run({source_url:"https://www.example.com/booking"});
    expect(result).toMatchObject({status:"rejected",existingUrl:"https://www.example.com/booking"});
    expect(ask).not.toHaveBeenCalled();
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
  it("leaves failed provider calls pending", async () => {
    fetchSerp.mockRejectedValue(new Error("provider unavailable"));
    expect((await run()).status).toBe("pending");
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
    expect(serpOverlap(urls,[...urls.slice(0,2),"https://four.test/a"])).toBeCloseTo(2/3);
    expect(serpOverlap(urls,urls.slice(0,1))).toBe(0);
  });
});
