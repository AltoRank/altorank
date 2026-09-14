import { beforeEach, describe, expect, it, vi } from "vitest";
const { ask, judge, fetchSerp, available } = vi.hoisted(() => ({ ask: vi.fn(), judge: vi.fn(), fetchSerp: vi.fn(), available: vi.fn(() => true) }));
vi.mock("../buyer-model", async (original) => ({ ...await original<object>(), modelAvailable: available, askStructured: ask }));
vi.mock("../editorial-task", () => ({ checkEditorialTask: async (_query: string, _organic: unknown, a: {angle:string;buyingJob:string;editorial:{reason:string}}) => ({status:"supported",task:{angle:a.angle,buyingJob:a.buyingJob,reason:a.editorial.reason}}) }));
vi.mock("../buyer-fit", () => ({ judgeBuyerFit: judge }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: available }));
vi.mock("../page-evidence", () => ({ readPageExtract: vi.fn(async (url: string) => ({ url, title: "Clinic booking", headings: ["Costs"], text: "Booking website costs and package options for clinic owners." })) }));
vi.mock("@/lib/seo/brief-data", () => ({ fetchAdvancedSerp: fetchSerp }));
import { qualifyOpportunities, readOpportunity, contextKey, serpOverlap, validArticleAngle, assertAutonomousTopic } from "../opportunity";
import { balanceSources, diverseSeeds } from "../diversity";
import { readPageExtract } from "../page-evidence";

const context = { domain: "example.com", languageCode: "it", locationCode: 2380, business: { name: "Clinic Studio", offerings: ["clinic booking websites"], audiences: ["clinic owners"] } };
const term = "clinic booking website costs";
const urls = ["https://one.test/guide", "https://two.test/guide", "https://three.test/guide"];
const approval = { approve: true, reason: "Clinic owners compare the cost of a booking website", audience: "clinic owners", buyingJob: "choose a booking website", offering: "clinic booking websites", angle: "What clinics should budget for a booking website", format: "article", conversionPath: "https://example.com/contact", evidenceUrls: urls.slice(0, 2),
results: urls.map((url) => ({ url, format: "article", quote: "A buyer guide" })),
buyer: { relevant: true, reason: "Clinic owners need booking websites" },
product: { supported: true, quote: "clinic booking websites", reason: "The offering serves their task" },
editorial: { achievable: true, reason: "Help compare costs and scope" }};
const writes: unknown[] = [];
let covered: unknown[] = [];
const db = { rpc: async()=>({data:true,error:null}), from: () => ({ select: () => { const q = { eq: () => q, in: async () => ({ data: covered, error: null }) }; return q; }, update: (row: unknown) => { writes.push(row); const q = { eq: () => q, then: (resolve: (v: unknown) => unknown) => resolve({error:null}) }; return q; } }) } as never;
beforeEach(() => {
  vi.clearAllMocks(); writes.length = 0; covered = []; available.mockReturnValue(true);
  judge.mockResolvedValue({ basis: "model", verdicts: new Map([[term, {keep:true,reason:"specific buyer need"}]]) });
  fetchSerp.mockResolvedValue({ organic: urls.map((url, i) => ({url,title:"Clinic booking website cost guide",description:"A buyer guide",rank:i+1})), peopleAlsoAsk:[],aiOverview:null });
  ask.mockResolvedValue(JSON.stringify(approval));
});
async function run(extra = {}) { return (await qualifyOpportunities(db, "ws", [{id:"k",term,...extra}], context)).get("k")!; }

describe("topic qualification", () => {
  it("reads complete page extracts during adjudication without passing array indices as character limits",async()=>{
    ask.mockResolvedValueOnce(JSON.stringify({...approval,results:urls.map(url=>({url,format:"tool",quote:"A buyer guide"}))})).mockResolvedValue(JSON.stringify(approval));
    await run();
    expect(readPageExtract).toHaveBeenCalled();
    for(const call of vi.mocked(readPageExtract).mock.calls)expect(call).toHaveLength(1);
  });
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
  it("preserves coverage across qualification versions, focus changes and cache expiry", async () => {
    const approved = await run();
    const old = {...approved, version:5, context:"older-focus", checkedAt:"2025-01-01T00:00:00Z"};
    expect(readOpportunity(old,contextKey(context))).toBeNull();
    covered = [{id:"published",term:"existing cost guide",opportunity:old}];
    expect(await run()).toMatchObject({status:"rejected",duplicateOf:"published"});
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
    expect(result).toMatchObject({status:"qualified",audience:approval.audience,angle:approval.angle,evidenceUrls:urls});
    expect(fetchSerp).toHaveBeenCalledWith(term, context);
  });
  it("does not accept invented evidence URLs", async () => {
    ask.mockResolvedValue(JSON.stringify({...approval,results:[{url:"https://invented.test/a",format:"article",quote:"A buyer guide"}]}));
    expect((await run()).status).toBe("pending");
  });
  it("does not treat a tool-dominated search as an approved article", async () => {
    ask.mockResolvedValue(JSON.stringify({...approval,results:urls.map(url=>({url,format:"tool",quote:"A buyer guide"}))}));
    expect((await run()).status).toBe("pending");
  });
  it("routes existing own-page targets to review instead of a new blog", async () => {
    ask.mockResolvedValue(JSON.stringify({ ...approval, existingPage: { url: "https://www.example.com/booking", sameTask: true, quote: "Booking website costs", reason: "This page covers the same decision" } }));
    const result = await run({source_url:"https://www.example.com/booking"});
    expect(result).toMatchObject({status:"rejected",existingUrl:"https://www.example.com/booking"});
    expect(ask).toHaveBeenCalled();
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

it("continues beyond twelve candidates until five distinct supported briefs exist", async () => {
  const candidates = Array.from({length:24},(_,i) => ({id:`k${i}`,term:`buyer task ${i}`}));
  judge.mockImplementation(async (_business,terms:string[]) => ({basis:"model",verdicts:new Map(terms.map((t) => [t,{keep:true,reason:"Relevant buyer"}]))}));
  fetchSerp.mockImplementation(async (query:string) => ({organic:[1,2,3].map((rank) => ({url:`https://source${rank}.test/${query.split(" ").at(-1)}`,title:"A buyer guide",description:"Compare costs",rank})),peopleAlsoAsk:[],aiOverview:null}));
  ask.mockImplementation(async (_operation,prompt:string) => {
    const input=JSON.parse(prompt.split("\n").at(-1)!);
    const index=Number(input.query.split(" ").at(-1));
    return JSON.stringify({...approval,results:input.results.map((r:{url:string}) => ({url:r.url,format:"article",quote:"A buyer guide"})),editorial:{achievable:index>=12,reason:index>=12?"Useful comparison":"Insufficient scope"}});
  });
  const result=await qualifyOpportunities(db,"ws",candidates,context);
  expect([...result.values()].filter((o) => o.status==="qualified")).toHaveLength(6);
  expect(fetchSerp).toHaveBeenCalledTimes(18); // Finish the bounded batch containing the fifth.
  expect(result.get("k17")?.qualificationRun).toMatchObject({checked:18,distinct:6,stopped:"sufficient"});
});

it("caps sparse research at 25 and records why it stopped", async () => {
  judge.mockImplementation(async (_business,terms:string[]) => ({basis:"model",verdicts:new Map(terms.map((t) => [t,{keep:false,reason:"Not this buyer"}]))}));
  const result=await qualifyOpportunities(db,"ws",Array.from({length:40},(_,i) => ({id:`k${i}`,term:`unrelated task ${i}`})),context);
  expect(result.size).toBe(25); expect(fetchSerp).not.toHaveBeenCalled();
  expect(result.get("k24")?.qualificationRun).toMatchObject({checked:25,distinct:0,stopped:"budget"});
});

it("continues researching when five distinct SERPs collapse to one buyer decision", async()=>{
 const candidates=Array.from({length:12},(_,i)=>({id:`k${i}`,term:`buyer task ${i}`}));
 judge.mockImplementation(async(_business,terms:string[])=>({basis:"model",verdicts:new Map(terms.map(t=>[t,{keep:true,reason:"Relevant"}]))}));
 fetchSerp.mockImplementation(async(query:string)=>({organic:[1,2,3].map(rank=>({url:`https://source${rank}.test/${query.split(" ").at(-1)}`,title:"A buyer guide",description:"Compare costs",rank})),peopleAlsoAsk:[],aiOverview:null}));
 ask.mockImplementation(async(operation:string,prompt:string)=>{
  const input=JSON.parse(prompt.split("\n").at(-1)!);
  if(operation==="onboarding/distinct-tasks")return JSON.stringify({groups:[input.topics.map((_:unknown,i:number)=>i)]});
  return JSON.stringify({...approval,results:input.results.map((r:{url:string})=>({url:r.url,format:"article",quote:"A buyer guide"}))});
 });
 const result=await qualifyOpportunities(db,"ws",candidates,context,{distinctTasks:true});
 expect(fetchSerp).toHaveBeenCalledTimes(12);
 expect(result.get("k11")?.qualificationRun).toMatchObject({checked:12,distinct:1,stopped:"exhausted"});
});
it("an explicit onboarding retry revisits incomplete checks while ordinary reads preserve the cache",async()=>{
 judge.mockResolvedValueOnce({basis:"model",verdicts:new Map()});
 const pending=await run();
 await run({opportunity:pending});expect(fetchSerp).not.toHaveBeenCalled();
 await qualifyOpportunities(db,"ws",[{id:"k",term,opportunity:pending}],context,{distinctTasks:true});
 expect(fetchSerp).not.toHaveBeenCalled();
 const result=await qualifyOpportunities(db,"ws",[{id:"k",term,opportunity:pending}],context,{distinctTasks:true,retryPending:true});
 expect(result.get("k")?.status).toBe("qualified");expect(fetchSerp).toHaveBeenCalledTimes(1);
});
import {decisionCoverageOrder} from "../evidence";
it("allocates a turn to each decision family before repeated category seeds",()=>{
 const rows=[{family:"category" as const,seed:"a"},{family:"category" as const,seed:"b"},{family:"category" as const,seed:"c"},{family:"migration" as const,seed:"switch"},{family:"problem" as const,seed:"fix"}];
 expect(decisionCoverageOrder(rows,row=>({...row,source:"ideas"}),3).map(r=>r.family)).toEqual(["category","migration","problem"]);
});
