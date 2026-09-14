import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb, asUser, type FakeDb } from "@/lib/onboarding/__tests__/fake-runs-client";
import {contextKey,OPPORTUNITY_VERSION} from "@/lib/keyword-research/opportunity";
import {draftPreparationContext} from "@/lib/content/draft-preparation";
let db: FakeDb;
let user: {id:string} | null;
const afters: Array<() => Promise<void>> = [];
const generate = vi.fn(); const fulfil = vi.fn();
const dispatch = vi.fn(); const canDispatch = vi.fn();
vi.mock("@/lib/supabase/server", () => ({createClient:async () => asUser(db,user),createServiceClient:() => db.client}));
vi.mock("@/lib/workspace-scope", () => ({getScopedWorkspaceId:async () => "ws1"}));
vi.mock("next/server", async () => ({...await vi.importActual<typeof import("next/server")>("next/server"),after:(fn:() => Promise<void>) => afters.push(fn)}));
vi.mock("@/lib/content/fan-out", () => ({canSelfInvoke:() => canDispatch(),dispatchFirstDraft:(...args:unknown[]) => dispatch(...args)}));
vi.mock("@/lib/content/generate", () => ({generateArticle:(...args:unknown[]) => generate(...args)}));
vi.mock("@/lib/onboarding/plan", () => ({fulfilPlannedEntry:(...args:unknown[]) => fulfil(...args)}));
vi.mock("@/lib/voice/train", () => ({trainVoiceProfile:async () => undefined}));
vi.mock("@/lib/onboarding/site-text", () => ({readSiteText:async () => ({text:""})}));
vi.mock("@/lib/linking/detect", () => ({detectLinks:async () => undefined}));
import {POST} from "../choose/route";
const request = (body:unknown) => new NextRequest("http://localhost/api/onboard/choose", {method:"POST",body:JSON.stringify(body)});
const choice = {workspaceId:"ws1",runId:"r1",keywordId:"k1"};
const profile={primaryBuyer:"Small teams",priorityOffering:"Writing software"};
const brief={version:OPPORTUNITY_VERSION,context:contextKey({domain:"example.com",business:profile,languageCode:"en",locationCode:2840}),checkedAt:new Date().toISOString(),status:"qualified" as const,angle:"Approved headline",reason:"Supported",audience:"Small teams",buyingJob:"Choose writing software",offering:"Writing software",format:"article" as const,evidenceUrls:["https://example.com/help","https://other.test/guide"],organicUrls:["https://example.com/help","https://other.test/guide"]};
const preparationContext=draftPreparationContext({workspaceId:"ws1",keywordId:"k1",keyword:"buyer task",brief,profile,domain:"example.com",language:"en",locationCode:2840});
let preparationCreatedAt:string;
beforeEach(() => {
  user={id:"u1"}; afters.length=0; generate.mockReset(); fulfil.mockReset();
  preparationCreatedAt=new Date(Date.now()-1000).toISOString();
  canDispatch.mockReset().mockReturnValue(false);dispatch.mockReset();
  generate.mockResolvedValue({articleId:"a1",title:"Approved headline",wordCount:1000,factCheck:{verdict:"review"}});
  db=fakeDb({workspaces:[{id:"ws1",domain:"example.com",account_id:"ac1",business_profile:profile,language:"en",location_code:2840}],onboarding_runs:[{id:"r1",workspace_id:"ws1",status:"awaiting_choice",phases:[],planned:[{term:"buyer task",keywordId:"k1",brief,preparation:{context:preparationContext}}]}],keywords:[{id:"k1",workspace_id:"ws1",opportunity:brief,instructions:null,plan_excluded_at:null}],draft_preparations:[{workspace_id:"ws1",keyword_id:"k1",payload:{version:1,context:preparationContext,createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),status:"ready",sources:[],plan:{status:"planned",requirements:["Which tool fits?"]},sourceBrief:{status:"prepared",facts:[{quote:"Evidence"}],coverage:[{question:"Which tool fits?",factIndices:[0]}],readiness:{status:"checked",questions:[{requirementIndex:0,answered:true}]}}}}],calendar_entries:[{id:"c1",workspace_id:"ws1",keyword_id:"k1",article_id:null}]});
  (db.tables.draft_preparations[0].payload as {createdAt:string}).createdAt=preparationCreatedAt;
  (db.tables.onboarding_runs[0].planned as Array<{preparation:{checkedAt?:string}}>)[0].preparation.checkedAt=preparationCreatedAt;
});
it("claims one saved choice and attaches the generated article to its calendar entry", async () => {
  expect((await POST(request(choice))).status).toBe(200);
  expect((await POST(request(choice))).status).toBe(409);
  expect(afters).toHaveLength(1); expect(generate).not.toHaveBeenCalled();
  await afters[0]();
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({workspaceId:"ws1",verifySourceClaims:true,expectedPreparationContext:preparationContext,expectedPreparationCreatedAt:preparationCreatedAt}));
  expect(fulfil).toHaveBeenCalledWith(db.client,"c1","a1");
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"done",article_id:"a1"});
  expect(db.tables.workspaces[0].onboarded_at).toBeTruthy();
});

it("dispatches the complete selected receipt to the separate writer",async()=>{
  canDispatch.mockReturnValue(true);
  dispatch.mockReturnValue({request:Promise.resolve(new Response(JSON.stringify({status:"generated"})))});
  expect((await POST(request(choice))).status).toBe(200);
  await afters[0]();
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({workspaceId:"ws1",runId:"r1",keywordId:"k1",expectedPreparationContext:preparationContext,expectedPreparationCreatedAt:preparationCreatedAt}));
  expect(generate).not.toHaveBeenCalled();
});
it.each(["renewed-packet","missing-timestamp"])("does not claim an old choice with a %s receipt",async(change)=>{
  if(change==="renewed-packet") (db.tables.draft_preparations[0].payload as {createdAt:string}).createdAt=new Date(Date.parse(preparationCreatedAt)+500).toISOString();
  else delete (db.tables.onboarding_runs[0].planned as Array<{preparation:{checkedAt?:string}}>)[0].preparation.checkedAt;
  expect((db.tables.draft_preparations[0].payload as {context:string}).context).toBe(preparationContext);
  expect((await POST(request(choice))).status).toBe(409);
  expect(db.tables.onboarding_runs[0].status).toBe("awaiting_choice");
  expect(afters).toHaveLength(0);expect(generate).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
});

it.each(["missing","expired","different-workspace","instructions","focus","malformed-brief"])("does not claim a draft with %s source preparation",async(change)=>{
  if(change==="missing") db.tables.draft_preparations=[];
  if(change==="expired") (db.tables.draft_preparations[0].payload as {expiresAt:string}).expiresAt=new Date(Date.now()-1).toISOString();
  if(change==="different-workspace") db.tables.draft_preparations[0].workspace_id="ws2";
  if(change==="instructions") db.tables.keywords[0].instructions="Compare a different plan";
  if(change==="focus") db.tables.workspaces[0].business_profile={primaryBuyer:"Enterprise admins"};
  if(change==="malformed-brief") db.tables.keywords[0].opportunity=null;
  expect((await POST(request(choice))).status).toBe(409);
  expect(db.tables.onboarding_runs[0].status).toBe("awaiting_choice");
  expect(afters).toHaveLength(0);expect(generate).not.toHaveBeenCalled();
});
it("refuses unsigned callers, another workspace and invented topics before claiming a run", async () => {
  user=null; expect((await POST(request(choice))).status).toBe(401); user={id:"u1"};
  expect((await POST(request({...choice,workspaceId:"ws2"}))).status).toBe(400);
  expect((await POST(request({...choice,keywordId:"not-in-plan"}))).status).toBe(400);
  db.tables.onboarding_runs[0].workspace_id="ws2";
  expect((await POST(request(choice))).status).toBe(404);
  expect(afters).toHaveLength(0);
});
it("allows focus refinement without drafting or marking setup complete", async () => {
  expect((await POST(request({...choice,refine:true}))).status).toBe(200);
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"partial",finished_at:null});
  expect(afters).toHaveLength(0); expect(db.tables.workspaces[0].onboarded_at).toBeUndefined();
});
it("preserves the saved plan and reports draft failures without completing setup", async () => {
  generate.mockRejectedValue(new Error("Draft allowance exhausted"));
  await POST(request(choice)); await afters[0]();
  expect(db.tables.onboarding_runs[0].planned).toHaveLength(1);
  expect(db.tables.onboarding_runs[0].phases).toContainEqual(expect.objectContaining({phase:"drafting",status:"failed"}));
  expect(db.tables.workspaces[0].onboarded_at).toBeUndefined();
});

it("a withheld draft preserves choices and returns to selection without completing onboarding", async()=>{
 const {DraftReadinessError}=await import("@/lib/content/draft-readiness");
 generate.mockRejectedValue(new DraftReadinessError("material-findings"));
 await POST(request(choice));await afters[0]();
 expect(db.tables.onboarding_runs[0]).toMatchObject({status:"awaiting_choice",finished_at:null});
 expect(db.tables.onboarding_runs[0].phases).toContainEqual(expect.objectContaining({phase:"drafting",status:"failed",detail:expect.stringContaining("no draft allowance was used")}));
 expect(fulfil).not.toHaveBeenCalled();expect(db.tables.workspaces[0].onboarded_at).toBeUndefined();
 generate.mockResolvedValue({articleId:"a2",title:"Approved headline",wordCount:900,factCheck:{verdict:"review"}});
 expect((await POST(request(choice))).status).toBe(200);await afters[1]();
 expect(fulfil).toHaveBeenCalledTimes(1);
});
