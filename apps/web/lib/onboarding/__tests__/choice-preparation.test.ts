import { beforeEach, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-runs-client";
import { queueChoicePreparation, prepareOnboardingChoices, wakeChoicePreparation } from "../choice-preparation";
import { contextKey, OPPORTUNITY_VERSION, type Opportunity } from "@/lib/keyword-research/opportunity";
import { DRAFT_PREPARATION_VERSION, draftPreparationContext, type DraftPreparation, type DraftPreparationInput } from "@/lib/content/draft-preparation";
import { currentResearchBudget } from "@/lib/seo/request-context";
import type { OnboardingPlanned } from "../events";

const how=vi.hoisted(()=>({invoke:vi.fn(),self:vi.fn()}));
vi.mock("@/lib/content/fan-out",()=>({selfInvocation:how.self,selfInvoke:how.invoke}));
const profile={primaryBuyer:"Small teams",priorityOffering:"Writing software"};
const context={domain:"publisher.test",business:profile,languageCode:"en",locationCode:2840};
const brief: Opportunity={version:OPPORTUNITY_VERSION,context:contextKey(context),checkedAt:new Date().toISOString(),status:"qualified",reason:"Helps small teams compare tools",audience:"Small teams",buyingJob:"Choose writing software",offering:"Writing software",angle:"How to compare writing software",format:"article",evidenceUrls:["https://one.test/guide","https://two.test/guide"],organicUrls:["https://one.test/guide","https://two.test/guide"],conversionPath:"https://publisher.test"};
const choices: OnboardingPlanned[]=Array.from({length:5},(_,index)=>({keywordId:`k${index}`,term:`writing task ${index}`,date:"2026-09-14",brief:{...brief,angle:`How to compare writing task ${index}`}}));
function database(count=2) {
  const candidates=choices.slice(0,count);
  const db=fakeDb({
    onboarding_runs:[{id:"r1",workspace_id:"ws1",status:"running",planned:candidates,phases:[{phase:"planning",status:"done"}]}],
    onboarding_choice_checks:[],
    workspaces:[{id:"ws1",domain:context.domain,language:"en",location_code:2840,business_profile:profile}],
    keywords:candidates.map(choice=>({id:choice.keywordId,workspace_id:"ws1",term:choice.term,opportunity:choice.brief,instructions:null,plan_excluded_at:null})),
  });
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
    const check=db.tables.onboarding_choice_checks.find(row=>row.run_id===args.p_run);
    const run=db.tables.onboarding_runs[0];
    if (name==="claim_onboarding_choices") {
      if (!check || run.status!=="running" || check.status==="done" || Number(check.attempts)>=2 || (check.lease_until && Date.parse(String(check.lease_until))>Date.now())) return {data:null,error:null};
      Object.assign(check,{status:"preparing",lease:"token",lease_until:new Date(Date.now()+360_000).toISOString(),attempts:Number(check.attempts??0)+1});
      return {data:"token",error:null};
    }
    if (name==="finish_onboarding_choices") {
      if (!check || check.lease!==args.p_token || Date.parse(String(check.lease_until))<=Date.now() || run.status!=="running") return {data:false,error:null};
      Object.assign(run,{planned:args.p_planned,phases:args.p_phases,status:(args.p_planned as unknown[]).length?"awaiting_choice":"partial"});
      Object.assign(check,{status:"done",results:args.p_results,lease:null,lease_until:null});
      return {data:true,error:null};
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  db.client.rpc=rpc as never;
  return {...db,rpc};
}
async function queued(db:ReturnType<typeof database>) {
  await queueChoicePreparation(db.client,"r1","ws1");
  Object.assign(db.tables.onboarding_choice_checks[0],{status:"queued",attempts:0,lease:null,lease_until:null});
  await db.rpc("claim_onboarding_choices",{p_run:"r1"});
}
function packet(input:DraftPreparationInput,status:DraftPreparation["status"]="ready"): DraftPreparation {
  const quote="Small teams can compare the writing tools and their editing options.";
  return {version:DRAFT_PREPARATION_VERSION,context:draftPreparationContext(input),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),status,sources:[{url:"https://one.test/guide",title:"Writing tools",headings:[],text:quote}],plan:{task:"explanation",status:"planned",requirements:["What does the buyer need?"],selectedUrls:[],retrievedUrls:[],scope:{status:"checked",requirements:["What does the buyer need?"],omitted:[],promises:[{id:"p0",source:"headline",quote:input.brief.angle!,text:input.brief.angle!,expectedAnswer:"Explain the approved reader task using the quoted evidence.",mappingReason:"The fixture question asks for the approved task.",requirementIndices:[0]}]}},sourceBrief:{status:status==="ready"?"prepared":status,facts:[{subject:"Small teams",plan:"",kind:"explanation",statement:quote,quote,scopeQuote:quote,sourceIndex:0,url:"https://one.test/guide"}],coverage:[{question:"What does the buyer need?",factIndices:[0]}],issues:[],readiness:{status:"checked",questions:[{requirementIndex:0,answered:true,reason:"Observed answers"}],promises:[{promiseId:"p0",answered:true,reason:"The quoted evidence supports the fixture promise."}]}}};
}
beforeEach(()=>{vi.clearAllMocks();how.self.mockReturnValue({baseUrl:"https://app.test",secret:"fixture",fetchImpl:fetch});how.invoke.mockResolvedValue(new Response(null,{status:202}));});
it("saves immutable candidate choices and hides unprepared selectable plans",async()=>{
  const db=database();await queueChoicePreparation(db.client,"r1","ws1");
  expect(db.tables.onboarding_choice_checks[0].candidates).toEqual(choices.slice(0,2));
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"running",planned:[],phases:expect.arrayContaining([expect.objectContaining({phase:"planning",status:"active"})])});
  await queueChoicePreparation(db.client,"r1","ws1");
  expect(db.tables.onboarding_choice_checks).toHaveLength(1);
  expect(db.tables.onboarding_choice_checks[0].candidates).toEqual(choices.slice(0,2));
});
it("exposes only prepared original choices with a reusable receipt",async()=>{
  const db=database();await queued(db);
  const prepare=vi.fn(async(_db,input:DraftPreparationInput)=>packet(input,input.keywordId==="k0"?"insufficient":"ready"));
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"awaiting_choice",planned:[{...choices[1],preparation:{context:expect.any(String),checkedAt:expect.any(String),requirements:["What does the buyer need?"]}}]});
  expect(db.tables.onboarding_choice_checks[0].results).toEqual([expect.objectContaining({keywordId:"k0",status:"insufficient"}),expect.objectContaining({keywordId:"k1",status:"ready"})]);
  expect(prepare.mock.calls[0][1]).toMatchObject({workspaceId:"ws1",keywordId:"k0",profile,brief:choices[0].brief});
});
it("rejects changed audience, locale or keyword task before provider work",async()=>{
  for (const change of ["focus","locale","task"] as const) {
    const db=database(1);await queued(db);
    if(change==="focus")db.tables.workspaces[0].business_profile={primaryBuyer:"Enterprise developers"};
    if(change==="locale")db.tables.workspaces[0].language="it";
    if(change==="task")db.tables.keywords[0].opportunity={...choices[0].brief,angle:"A completely different task"};
    const prepare=vi.fn();await prepareOnboardingChoices(db.client,"r1","token",{prepare});
    expect(prepare).not.toHaveBeenCalled();
    expect(db.tables.onboarding_runs[0]).toMatchObject({status:"partial",planned:[]});
    expect(db.tables.onboarding_choice_checks[0].results).toEqual([expect.objectContaining({status:"changed"})]);
  }
});
it("rechecks the current task after a concurrent edit during source collection",async()=>{
  const db=database(1);await queued(db);
  const prepare=vi.fn(async(_db,input:DraftPreparationInput)=>{
    db.tables.keywords[0].instructions="A newly edited instruction";
    return packet(input);
  });
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"partial",planned:[]});
  expect(db.tables.onboarding_choice_checks[0].results).toEqual([expect.objectContaining({status:"changed"})]);
});
it("withdraws a choice when standing instructions change during source preparation",async()=>{
  const db=database(1);await queued(db);
  db.tables.workspace_output_settings=[{workspace_id:"ws1",global_article_prompt:"Always mention the free tier."}];
  const prepare=vi.fn(async(_db,input:DraftPreparationInput)=>{
    expect(input.globalInstructions).toBe("Always mention the free tier.");
    db.tables.workspace_output_settings[0].global_article_prompt="Always explain the paid plan limits.";
    return packet(input);
  });
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(prepare).toHaveBeenCalledOnce();
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"partial",planned:[]});
  expect(db.tables.onboarding_choice_checks[0].results).toEqual([expect.objectContaining({status:"changed"})]);
});
it("withholds choices before provider work when standing instructions cannot be read",async()=>{
  const db=database(1);await queued(db);
  const from=db.client.from.bind(db.client);
  const failed={select:()=>failed,eq:()=>failed,maybeSingle:async()=>({data:null,error:{message:"Unavailable"}})};
  vi.spyOn(db.client,"from").mockImplementation(table=>table==="workspace_output_settings"?failed as never:from(table));
  const prepare=vi.fn();
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(prepare).not.toHaveBeenCalled();
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"partial",planned:[]});
  expect(db.tables.onboarding_choice_checks[0].results).toEqual([expect.objectContaining({status:"unavailable"})]);
});
it("rechecks already-prepared choices when a later candidate sees a focus change",async()=>{
  const db=database(3);await queued(db);
  const prepare=vi.fn(async(_db,input:DraftPreparationInput)=>{
    if(input.keywordId==="k2")db.tables.workspaces[0].business_profile={primaryBuyer:"A different buyer"};
    return packet(input);
  });
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"partial",planned:[]});
});
it("does not let an expired or replaced lease expose late results",async()=>{
  const db=database(1);await queued(db);
  const prepare=vi.fn(async(_db,input:DraftPreparationInput)=>{db.tables.onboarding_choice_checks[0].lease="replacement";return packet(input);});
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(db.tables.onboarding_runs[0].status).toBe("running");
  expect(db.rpc.mock.calls.some(([name])=>name==="finish_onboarding_choices")).toBe(false);
  prepare.mockClear();
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(prepare).not.toHaveBeenCalled();
});
it("closes a packet rejected at the final transaction without exposing a changed choice",async()=>{
  const db=database(1);await queued(db);
  const actual=db.rpc.getMockImplementation()!;
  db.rpc.mockImplementation(async(name,args)=>name==="finish_onboarding_choices"&&(args.p_planned as unknown[]).length ? {data:false,error:null} : actual(name,args));
  await prepareOnboardingChoices(db.client,"r1","token",{prepare:async(_db,input)=>packet(input)});
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"partial",planned:[]});
  expect(db.tables.onboarding_choice_checks[0].results).toEqual([expect.objectContaining({status:"changed"})]);
});
it("records provider failures separately from unsupported evidence without discarding ready topics",async()=>{
  const db=database();await queued(db);
  const prepare=vi.fn(async(_db,input:DraftPreparationInput)=>{if(input.keywordId==="k0")throw new Error("provider failed");return packet(input);});
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(db.tables.onboarding_runs[0].status).toBe("awaiting_choice");
  expect(db.tables.onboarding_choice_checks[0].results).toEqual([expect.objectContaining({status:"unavailable"}),expect.objectContaining({status:"ready"})]);
});
it.each([1,2])("refreshes an unavailable cached check once in claimed research attempt %i",async(attempts)=>{
  const db=database(1);await queued(db);
  db.tables.onboarding_choice_checks[0].attempts=attempts;
  const prepare=vi.fn(async(_db,input:DraftPreparationInput,options?:{retryUnavailable?:boolean})=>packet(input,options?.retryUnavailable?"ready":"unavailable"));
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledWith(db.client,expect.objectContaining({keywordId:"k0"}),{retryUnavailable:true});
  expect(db.tables.onboarding_runs[0].status).toBe("awaiting_choice");
  // Replayed dispatch after completion cannot trigger a second source attempt.
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(prepare).toHaveBeenCalledTimes(1);
});
it("does not prepare candidates beyond the two-attempt worker limit",async()=>{
  const db=database(1);await queued(db);
  db.tables.onboarding_choice_checks[0].attempts=3;
  const prepare=vi.fn();
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(prepare).not.toHaveBeenCalled();
  expect(db.tables.onboarding_runs[0].status).toBe("running");
});
it("caps concurrent candidates at two and preserves discovered order",async()=>{
  const db=database(5);await queued(db);let active=0;let peak=0;
  const prepare=vi.fn(async(_db,input:DraftPreparationInput)=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return packet(input);});
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(peak).toBe(2);expect(prepare).toHaveBeenCalledTimes(5);
  expect((db.tables.onboarding_runs[0].planned as OnboardingPlanned[]).map(choice=>choice.keywordId)).toEqual(choices.map(choice=>choice.keywordId));
});
it("retains successful work and records unstarted checks when the shared budget is spent",async()=>{
  const db=database(5);await queued(db);
  const prepare=vi.fn(async(_db,input:DraftPreparationInput)=>{const budget=currentResearchBudget()!;while(!budget.exhausted)budget.reserve();return packet(input);});
  await prepareOnboardingChoices(db.client,"r1","token",{prepare});
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(2);
  expect(db.tables.onboarding_choice_checks[0].results).toEqual(expect.arrayContaining([expect.objectContaining({status:"unavailable",reason:expect.stringContaining("request or time limit")})]));
});
it("refresh resumes a queued or expired source check but not active work or discovery",async()=>{
  const db=database();await queueChoicePreparation(db.client,"r1","ws1");
  await wakeChoicePreparation(db.client,"r1");expect(how.invoke).toHaveBeenCalledWith("/api/internal/onboard-choices",{runId:"r1"},expect.anything());
  how.invoke.mockClear();Object.assign(db.tables.onboarding_choice_checks[0],{status:"preparing",lease_until:new Date(Date.now()+60_000).toISOString()});
  await wakeChoicePreparation(db.client,"r1");expect(how.invoke).not.toHaveBeenCalled();
  db.tables.onboarding_choice_checks[0].lease_until=new Date(Date.now()-1).toISOString();
  await wakeChoicePreparation(db.client,"r1");expect(how.invoke).toHaveBeenCalledOnce();
  how.invoke.mockClear();await wakeChoicePreparation(db.client,"unknown-run");expect(how.invoke).not.toHaveBeenCalled();
});
it("keeps an inline fallback queued when discovery has spent the invocation budget",async()=>{
  const db=database();await queueChoicePreparation(db.client,"r1","ws1");how.self.mockReturnValue({skipped:"no-secret"});
  await wakeChoicePreparation(db.client,"r1",{durationMs:5000});expect(db.rpc).not.toHaveBeenCalled();
});


it("counts lease-loading time inside the source preparation deadline", async () => {
  const db=database(1);await queued(db);
  const started=Date.now();let now=started;
  const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
  const from=db.client.from.bind(db.client);
  db.client.from=((table:string)=>{if(table==="onboarding_runs")now+=45_000;return from(table);}) as typeof db.client.from;
  const prepare=vi.fn(async(_db,input:DraftPreparationInput)=>{
    expect(currentResearchBudget()?.deadline).toBe(started+85_000);
    expect(currentResearchBudget()!.deadline-Date.now()).toBe(40_000);
    return packet(input);
  });
  try { await prepareOnboardingChoices(db.client,"r1","token",{durationMs:85_000,prepare}); }
  finally { clock.mockRestore(); }
  expect(prepare).toHaveBeenCalledOnce();
});

it("does not restart an inline source budget after a slow claim consumes it", async () => {
  const db=database(1);await queueChoicePreparation(db.client,"r1","ws1");
  Object.assign(db.tables.onboarding_choice_checks[0],{status:"queued",attempts:0,lease:null,lease_until:null});
  how.self.mockReturnValue({skipped:"no-secret"});
  const started=Date.now();let now=started;
  const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
  const rpc=db.client.rpc.bind(db.client);
  db.client.rpc=(async(name:string,args:Record<string,unknown>)=>{
    const result=await rpc(name,args);
    if(name==="claim_onboarding_choices")now+=85_000;
    return result;
  }) as unknown as typeof db.client.rpc;
  const from=vi.spyOn(db.client,"from");
  try { await wakeChoicePreparation(db.client,"r1",{durationMs:85_000}); }
  finally { clock.mockRestore(); }
  expect(from.mock.calls.some(([table])=>table==="keywords")).toBe(false);
  expect(db.tables.onboarding_runs[0].status).toBe("partial");
  expect(db.tables.onboarding_choice_checks[0].results).toEqual([expect.objectContaining({status:"unavailable",reason:expect.stringContaining("time limit")})]);
});
