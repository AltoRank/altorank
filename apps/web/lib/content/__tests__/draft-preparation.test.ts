import {beforeEach,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {contextKey,OPPORTUNITY_VERSION} from "@/lib/keyword-research/opportunity";
import {DRAFT_PREPARATION_VERSION,draftPreparationContext,loadDraftPreparation,prepareDraft,readDraftPreparation,draftPreparationTask,type DraftPreparation,type DraftPreparationInput} from "../draft-preparation";
const mock=vi.hoisted(()=>({collect:vi.fn(),brief:vi.fn()}));
vi.mock("../draft-evidence",async()=>({...await vi.importActual<typeof import("../draft-evidence")>("../draft-evidence"),collectTaskEvidence:mock.collect}));
vi.mock("../source-brief",()=>({prepareSourceBrief:mock.brief}));
const input:DraftPreparationInput={workspaceId:"ws1",keywordId:"k1",keyword:"compare tools",domain:"example.com",language:"en",locationCode:2840,profile:{primaryBuyer:"Small teams",priorityOffering:"Writing software"},brief:{version:OPPORTUNITY_VERSION,context:contextKey({domain:"example.com",business:null,languageCode:"en",locationCode:2840}),checkedAt:"2026-09-14T00:00:00Z",status:"qualified",reason:"Relevant",audience:"Small teams",offering:"Writing software",buyingJob:"Select software",angle:"Compare writing tools",format:"article",evidenceUrls:["https://example.com/help"]}};
const sources=[{url:"https://example.com/help",title:"Help",headings:[],text:"Shared documents support team reviews."}];
const plan={status:"planned" as const,task:"explanation" as const,requirements:["How do reviews work?"],selectedUrls:[],retrievedUrls:[sources[0].url],scope:{status:"checked" as const,requirements:["How do reviews work?"],omitted:[],promises:[{id:"p0",source:"headline" as const,quote:input.brief.angle!,text:input.brief.angle!,expectedAnswer:"Explain the approved reader task using the quoted evidence.",mappingReason:"The fixture question asks for the approved task.",requirementIndices:[0]}]}};
const sourceBrief={status:"prepared" as const,facts:[{subject:"Example",plan:"",kind:"capability" as const,statement:sources[0].text,sourceIndex:0,quote:sources[0].text,scopeQuote:sources[0].text,url:sources[0].url}],coverage:[{question:plan.requirements[0],factIndices:[0]}],issues:[],readiness:{status:"checked" as const,questions:[{requirementIndex:0,answered:true,reason:"Direct instructions."}],promises:[{promiseId:"p0",answered:true,reason:"The quoted evidence supports the fixture promise."}]}};
function packet():DraftPreparation{return structuredClone({version:DRAFT_PREPARATION_VERSION,context:draftPreparationContext(input),createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),status:"ready",sources,plan,sourceBrief});}
function database(initial?:DraftPreparation){
  const rows:Array<{workspace_id:string;keyword_id:string;payload:DraftPreparation}>=initial?[{workspace_id:"ws1",keyword_id:"k1",payload:initial}]:[];
  let error:unknown=null;
  const from=vi.fn((table:string)=>{
    expect(table).toBe("draft_preparations");
    const filters:Record<string,string>={};
    const q={select:()=>q,eq:(key:string,value:string)=>{filters[key]=value;return q;},maybeSingle:async()=>({data:rows.find(r=>Object.entries(filters).every(([k,v])=>r[k as "workspace_id"|"keyword_id"]===v))??null,error}),upsert:async(row:typeof rows[number])=>{if(!error){const index=rows.findIndex(r=>r.workspace_id===row.workspace_id&&r.keyword_id===row.keyword_id);if(index<0)rows.push(row);else rows[index]=row;}return {error};}};
    return q;
  });
  return {client:{from} as unknown as SupabaseClient,rows,fail:()=>{error={message:"Unavailable"};}};
}
beforeEach(()=>{vi.clearAllMocks();mock.collect.mockResolvedValue({sources,plan});mock.brief.mockResolvedValue(sourceBrief);});
it("prepares once, persists the exact scope and reuses it without more provider calls",async()=>{
  const db=database();const first=await prepareDraft(db.client,input);const second=await prepareDraft(db.client,input);
  expect(first.status).toBe("ready");expect(second).toEqual(first);expect(mock.collect).toHaveBeenCalledOnce();expect(mock.brief).toHaveBeenCalledOnce();expect(db.rows).toHaveLength(1);
});
it("loads only the exact source packet named by the selected receipt",async()=>{
  const selected=packet();const db=database(selected);
  const receipt={context:selected.context,createdAt:selected.createdAt};
  expect(await loadDraftPreparation(db.client,input,receipt)).toEqual(selected);
  const renewed={...selected,createdAt:new Date(Date.parse(selected.createdAt)+500).toISOString()};
  db.rows[0].payload=renewed;
  expect(await loadDraftPreparation(db.client,input,receipt)).toBeNull();
  expect(await loadDraftPreparation(db.client,input,{context:selected.context,createdAt:undefined})).toBeNull();
  expect(await loadDraftPreparation(db.client,input,{context:"different-context",createdAt:renewed.createdAt})).toBeNull();
  expect(await loadDraftPreparation(db.client,input)).toEqual(renewed);
  expect(mock.collect).not.toHaveBeenCalled();expect(mock.brief).not.toHaveBeenCalled();
});
it.each(["workspaceId","keywordId","keyword","domain","language","locationCode","profile","instructions","globalInstructions","brief"] as const)("invalidates preparation when %s changes",async(field)=>{
  const db=database(packet());const changed={...input,[field]:field==="profile"?{primaryBuyer:"Different buyer"}:field==="brief"?{...input.brief,angle:"A different promise"}:field==="locationCode"?2826:"changed"};
  expect(await loadDraftPreparation(db.client,changed)).toBeNull();
});
it("prepares source questions and facts against both standing and article instructions",async()=>{
  const value={...input,globalInstructions:"Always mention the free tier.",instructions:"Compare monthly limits."};
  const task=draftPreparationTask(value);
  await prepareDraft(database().client,value);
  expect(task.instructions).toContain(value.globalInstructions);
  expect(task.instructions).toContain(value.instructions);
  expect(mock.collect).toHaveBeenCalledWith(value.profile,value.brief.conversionPath,value.brief.evidenceUrls,expect.objectContaining({instructions:task.instructions}),expect.anything());
  expect(mock.brief).toHaveBeenCalledWith(sources,plan,expect.objectContaining({instructions:task.instructions}),value.domain,expect.anything());
  expect(draftPreparationContext({...input,globalInstructions:"  "})).toBe(draftPreparationContext(input));
});
it("ignores grouping and check timestamps, but preserves changes to source identity",()=>{
  expect(draftPreparationContext({...input,brief:{...input.brief,checkedAt:new Date().toISOString(),taskKey:"new-group"}})).toBe(draftPreparationContext(input));
  expect(draftPreparationContext({...input,brief:{...input.brief,evidenceUrls:["https://example.com/different"]}})).not.toBe(draftPreparationContext(input));
});
it.each(["expired","future","legacy-version","missing-promises","unsupported-promise","wrong-promise-question","missing-questions","duplicate-indices","false-answer","empty-facts","wrong-coverage"])("rejects %s cache records without throwing",kind=>{
  const p=packet();
  if(kind==="expired")p.expiresAt=new Date(Date.now()-1).toISOString();
  if(kind==="future")p.createdAt=new Date(Date.now()+10000).toISOString();
  if(kind==="legacy-version")p.version=1;
  if(kind==="missing-promises")delete p.plan.scope!.promises;
  if(kind==="unsupported-promise")p.plan.scope!.promises![0].quote="A promise outside the approved headline";
  if(kind==="wrong-promise-question")p.plan.scope!.promises![0].requirementIndices=[1];
  if(kind==="missing-questions")delete (p.plan as Partial<typeof plan>).requirements;
  if(kind==="duplicate-indices"){p.plan.requirements.push("Second question");p.sourceBrief.readiness!.questions.push({...p.sourceBrief.readiness!.questions[0]});}
  if(kind==="false-answer")p.sourceBrief.readiness!.questions[0].answered=false;
  if(kind==="empty-facts")p.sourceBrief.facts=[];
  if(kind==="wrong-coverage")p.sourceBrief.coverage[0].question="A different question";
  expect(readDraftPreparation(p,p.context,draftPreparationTask(input))).toBeNull();
});
it("retries unavailable preparation only on an explicit bounded retry, keeping insufficient cached",async()=>{
  const p=packet();p.status="unavailable";p.sourceBrief.status="unavailable";const db=database(p);
  expect((await prepareDraft(db.client,input)).status).toBe("unavailable");expect(mock.collect).not.toHaveBeenCalled();
  expect((await prepareDraft(db.client,input,{retryUnavailable:true})).status).toBe("ready");expect(mock.collect).toHaveBeenCalledOnce();
  p.status="insufficient";p.sourceBrief.status="insufficient";const sparse=database(p);
  expect((await prepareDraft(sparse.client,input,{retryUnavailable:true})).status).toBe("insufficient");expect(mock.collect).toHaveBeenCalledOnce();
});
it("surfaces storage failures before spending on source collection",async()=>{
  const db=database();db.fail();await expect(prepareDraft(db.client,input)).rejects.toThrow("could not be loaded");expect(mock.collect).not.toHaveBeenCalled();
});
