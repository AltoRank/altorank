import {beforeEach,it,expect,vi} from "vitest";
import type {PageExtract,PageReadOutcome,PageReadFailureReason} from "@/lib/keyword-research/page-evidence";
import type {BusinessFocus} from "@/lib/onboarding/profile-focus";
const {read,ask}=vi.hoisted(()=>({read:vi.fn(),ask:vi.fn()}));
vi.mock("@/lib/keyword-research/page-evidence",()=>({readPageExtractOutcome:read}));
vi.mock("@/lib/keyword-research/buyer-model",()=>({askStructured:ask,extractJson:(raw:string)=>{try{return JSON.parse(raw);}catch{return null;}}}));
vi.mock("../rendered-evidence",()=>({recoverRenderedPricing:async(sources:PageExtract[])=>sources}));
import {collectDraftEvidence,collectTaskEvidence as collectTaskEvidenceImpl,withCapabilityEvidence,retrievedCitationPages} from "../draft-evidence";
import {unwrapUnknownInternalLinks} from "@/lib/seo/link-resolver";
const collectTaskEvidence:typeof collectTaskEvidenceImpl=(profile,url,search,brief,spend)=>collectTaskEvidenceImpl(profile,url,search,{angle:"Approved article task",...(brief as object)},spend);

function scopeResponse(value:{coverage:unknown;promises:Array<Record<string,unknown>>;questions:Array<{requirementIndex:number;essential:boolean;reason:string}>}):string {
  return JSON.stringify({...value,questions:Object.fromEntries(value.questions.map(({requirementIndex,...q})=>[`q${requirementIndex}`,q])),promises:value.promises.map(({requirementIndices,mappingReason},index)=>({id:`p${index}`,mappingReason,questionKeys:(requirementIndices as number[]).map(i=>`q${i}`)}))});
}
const link=(url:string)=>({url,label:url.split("/").pop()||"Product"});
const diagnostics=(url:string)=>({url,httpStatus:200,contentType:"text/html",bytesRead:400,bodyTruncated:false,excerptTruncated:false,extractedChars:200,strategy:"main" as const});
function success(url:string,links:NonNullable<PageExtract["links"]>=[],overrides:Partial<PageExtract>={}):PageReadOutcome {
  return {status:"success",diagnostics:diagnostics(url),page:{url,title:"Source",headings:[],text:"Product information with supported capabilities and limits. ".repeat(4),links,...overrides}};
}
function routing(url:string,links:NonNullable<PageExtract["links"]>):PageReadOutcome {
  return {status:"insufficient",reason:"short-extraction",diagnostics:{...diagnostics(url),extractedChars:20},page:{url,title:"Get support",headings:[],text:"Choose customer help",links}};
}
function failure(url:string,reason:PageReadFailureReason="http-error"):PageReadOutcome {
  return {status:"unavailable",reason,diagnostics:{...diagnostics(url),httpStatus:reason==="http-error"?404:undefined,bytesRead:0,extractedChars:0}};
}
type TestPlan={task:"comparison"|"procedure"|"explanation";requirements:string[];linkIndices:number[]};
function planner(plan:TestPlan,options:{essential?:number[];followups?:number[][];scopeUnavailable?:boolean;missingCentralTask?:boolean}={}) {
  let nextFollowup=0;
  ask.mockImplementation(async(operation:string,prompt:string)=>{
    if(operation==="article/evidence-plan")return JSON.stringify(plan);
    if(operation==="article/approved-promises") {
      const payload=JSON.parse(prompt.split("\n").at(-1)!);
      return JSON.stringify({promises:[{source:"headline",quote:payload.article.angle,text:"Deliver the supplied task",expectedAnswer:"Explain the approved workflow"},...(options.missingCentralTask?[{source:"headline",quote:payload.article.angle,text:"Complete the missing booking action",expectedAnswer:"Actual booking actions"}]:[])]});
    }
    if(operation==="article/evidence-scope") {
      const payload=JSON.parse(prompt.split("\n").at(-1)!);
      const essential=plan.requirements.flatMap((_,i)=>(options.essential?.includes(i)??true)?[i]:[]);
      return options.scopeUnavailable?null:scopeResponse({coverage:{complete:!options.missingCentralTask,reason:options.missingCentralTask?"The booking steps promised by the headline are absent.":"Retained questions cover the approved task."},promises:[{source:"headline",quote:payload.article.angle,text:"Deliver the supplied task",expectedAnswer:"Explain the approved workflow",mappingReason:"The retained questions ask about that workflow",requirementIndices:essential},...(options.missingCentralTask?[{source:"headline",quote:payload.article.angle,text:"Complete the missing booking action",expectedAnswer:"Actual booking actions",mappingReason:"No supplied question asks for booking actions",requirementIndices:[]}]:[])],questions:plan.requirements.map((question,requirementIndex)=>({requirementIndex,essential:options.essential?.includes(requirementIndex)??true,reason:`Scope judgment for: ${question}`}))});
    }
    if(operation==="article/evidence-plan-repair")return null;
    if(operation==="article/evidence-followup")return JSON.stringify({linkIndices:options.followups?.[nextFollowup++]??[]});
    throw new Error(`Unexpected operation: ${operation}`);
  });
}
beforeEach(()=>{vi.resetAllMocks();});

it("follows only selected observed source URLs and records missing retrieval",async()=>{
  read.mockImplementation(async(url:string)=>url==="https://review.test/list"?success(url,[link("https://vendor.test/docs")]):failure(url));
  planner({task:"comparison",requirements:["Which exports are supported?"],linkIndices:[0]});
  const result=await collectTaskEvidence(null,undefined,["https://review.test/list"],{});
  expect(result.plan.selectedUrls).toEqual(["https://vendor.test/docs"]);
  expect(result.plan.retrievedUrls).toEqual([]);
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0].links).toBeUndefined();
  expect(result.plan.reads).toMatchObject([{status:"success"},{status:"unavailable",reason:"http-error",diagnostics:{url:"https://vendor.test/docs",httpStatus:404}}]);
});

it.each([
  {requirements:["Which exports are supported?"],linkIndices:[17]},
  {requirements:[],linkIndices:[]},
  {requirements:["First?","Second?","Third?","Unapproved fourth?"],linkIndices:[0]},
  {requirements:["First?"],linkIndices:[0,0,0,0,0,0,0]},
])("refuses invalid plans before following destinations: %j",async invalid=>{
  read.mockImplementation(async(url:string)=>success(url,[link("https://vendor.test/docs")]));
  planner({task:"comparison",...invalid});
  const result=await collectTaskEvidence(null,undefined,["https://review.test/list"],{});
  expect(result.plan.status).toBe("unavailable");
  expect(read).toHaveBeenCalledTimes(1);
  expect(ask).toHaveBeenCalledTimes(1);
});

it("retains observed capability quotations when a later page read omits them",()=>{
  const quote="We check every participant's calendar before offering a time.";
  const profile:BusinessFocus={capabilities:[{claim:"Collective availability",quote,sourceUrl:"https://cal.test/collective",status:"observed"},{claim:"Invented support",quote:"Invented capability evidence",sourceUrl:"https://cal.test/other",status:"inferred"}]};
  const sources=withCapabilityEvidence([{url:"https://cal.test/collective",title:"Collective",headings:[],text:"Navigation only"}],profile);
  expect(sources).toHaveLength(1);expect(sources[0].text).toContain(quote);
  expect(withCapabilityEvidence(sources,profile)).toEqual(sources);
});

it("keeps retrieved internal citations while removing invented and profile-only destinations",()=>{
  const sources=withCapabilityEvidence([{url:"https://cal.test/pricing",title:"Pricing",headings:[],text:"Teams costs $12 per user billed yearly."}],{capabilities:[{claim:"Collective events",quote:"Collective events check every participant calendar.",sourceUrl:"https://cal.test/collective",status:"observed"}]});
  const html='<p><a href="https://cal.test/pricing">pricing</a> <a href="https://cal.test/invented">invented</a> <a href="https://cal.test/collective">profile only</a></p>';
  const checked=unwrapUnknownInternalLinks(html,"cal.test",retrievedCitationPages(sources));
  expect(checked.html).toContain('href="https://cal.test/pricing"');
  expect(checked.removed.map(r=>r.href)).toEqual(["https://cal.test/invented","https://cal.test/collective"]);
});

it("rejects credential-bearing or non-web capability URLs",()=>{
  const capabilities=["javascript:alert(1)","https://user:secret@cal.test/features"].map(sourceUrl=>({claim:"Feature",quote:"A sufficiently long supplied quotation.",sourceUrl,status:"observed" as const}));
  expect(withCapabilityEvidence([],{capabilities})).toEqual([]);
});

it("can retrieve missing pricing for multiple vendors in one bounded planning round",async()=>{
  const links=Array.from({length:6},(_,i)=>link(`https://vendor${i}.test/pricing`));
  read.mockImplementation(async(url:string)=>success(url,url==="https://review.test/list"?links:[]));
  planner({task:"comparison",requirements:["What does each team cost?"],linkIndices:[0,1,2,3,4,5]});
  const result=await collectTaskEvidence(null,undefined,["https://review.test/list"],{});
  expect(result.plan.retrievedUrls).toHaveLength(6);expect(read).toHaveBeenCalledTimes(7);
});

it("can follow an observed vendor homepage to its primary pricing page once",async()=>{
  read.mockImplementation(async(url:string)=>success(url,url==="https://review.test/list"?[link("https://vendor.test/")]:url==="https://vendor.test/"?[link("https://vendor.test/pricing")]:[]));
  planner({task:"comparison",requirements:["Which plan includes logic?"],linkIndices:[0]},{followups:[[0]]});
  const result=await collectTaskEvidence(null,undefined,["https://review.test/list"],{});
  expect(result.plan.retrievedUrls).toEqual(["https://vendor.test/","https://vendor.test/pricing"]);
  expect(ask).toHaveBeenCalledTimes(4);expect(read).toHaveBeenCalledTimes(3);
});

it("follows an observed manufacturer help hub to actual care instructions",async()=>{
  read.mockImplementation(async(url:string)=>success(url,url==="https://brand.test/shoes"?[link("https://brand.test/help")]:url==="https://brand.test/help"?[link("https://brand.test/help/wash")]:[]));
  planner({task:"procedure",requirements:["How should these shoes be washed?"],linkIndices:[0]},{followups:[[0]]});
  const result=await collectTaskEvidence(null,"https://brand.test/shoes",[],{});
  expect(result.plan.retrievedUrls).toEqual(["https://brand.test/help","https://brand.test/help/wash"]);
  expect(ask).toHaveBeenCalledTimes(4);
});

it("uses short routing pages through three follow-ups while preserving the frozen buyer task",async()=>{
  const paths=["https://fresha.test/app","https://fresha.test/help","https://fresha.test/help/customers","https://fresha.test/help/customers/booking","https://fresha.test/help/customers/booking/steps"];
  read.mockImplementation(async(url:string)=>{
    const index=paths.indexOf(url);
    if(index===0)return success(url,[link(paths[1])]);
    if(index===paths.length-1)return success(url,[],{text:"Choose a salon, choose an available treatment and time, and confirm your appointment."});
    return routing(url,[link(paths[index+1])]);
  });
  const requirements=["How can a customer find nearby salons?","What are the steps for booking an appointment?"];
  planner({task:"procedure",requirements,linkIndices:[0]},{followups:[[0],[0],[0]]});
  const brief={angle:"Find a salon and book an appointment",audience:"Customers looking for a salon",buyingJob:"Find and book a treatment"};
  const result=await collectTaskEvidence(null,paths[0],[],brief);
  expect(read.mock.calls.map(([url])=>url)).toEqual(paths);
  expect(result.sources.map(source=>source.url)).toEqual([paths[0],paths[4]]);
  expect(result.plan.retrievedUrls).toEqual([paths[4]]);
  expect(result.plan.requirements).toEqual(requirements.slice(0,2));
  expect(result.plan.reads?.map(outcome=>outcome.status)).toEqual(["success","insufficient","insufficient","insufficient","success"]);
  const followups=ask.mock.calls.filter(([operation])=>operation==="article/evidence-followup");
  expect(followups).toHaveLength(3);
  for(const [,prompt] of followups){
    const payload=JSON.parse(prompt.split("\n").at(-1));
    expect(payload.requirements).toEqual(requirements.slice(0,2));
    expect(payload.brief).toMatchObject(brief);
  }
});

it("reselects links after optional scope is removed without reading the omitted criterion",async()=>{
  const start="https://fresha.test/app",optional="https://fresha.test/help/payments",booking="https://fresha.test/help/booking";
  read.mockImplementation(async(url:string)=>success(url,url===start?[link(optional),link(booking)]:[]));
  const requirements=["How can a customer find nearby salons?","What are the steps for booking an appointment?","How can a customer cancel, reschedule or pay later?"];
  // Supplied judgments exercise their propagation, not live-model accuracy.
  planner({task:"procedure",requirements,linkIndices:[0]},{essential:[0,1],followups:[[1],[]]});
  const result=await collectTaskEvidence(null,start,[],{angle:"Find and book a salon appointment"});
  expect(read.mock.calls.map(([url])=>url)).toEqual([start,booking]);
  expect(result.plan.selectedUrls).toEqual([booking]);
  expect(result.plan.scope?.omitted[0].question).toBe(requirements[2]);
  for(const [,prompt] of ask.mock.calls.filter(([operation])=>operation==="article/evidence-followup")){
    expect(JSON.parse(prompt.split("\n").at(-1)).requirements).toEqual(requirements.slice(0,2));
  }
});

it("withholds source preparation when booking steps are missing from a find-and-book checklist",async()=>{
  read.mockImplementation(async(url:string)=>success(url,[link("https://fresha.test/help/find-salons")]));
  planner({task:"procedure",requirements:["How can customers find nearby salons?"],linkIndices:[0]},{missingCentralTask:true});
  const result=await collectTaskEvidence(null,"https://fresha.test/app",[],{angle:"Find a salon and book an appointment",buyingJob:"Find and book a treatment"});
  expect(result.plan).toMatchObject({status:"unavailable",requirements:[],scope:{status:"unavailable",coverage:{complete:false}}});
  expect(read).toHaveBeenCalledTimes(1);
  expect(ask).toHaveBeenCalledTimes(4);
});

it("counts failed requests toward the twelve-attempt budget and retains each cause",async()=>{
  const start="https://vendor.test/";
  const links=Array.from({length:20},(_,i)=>link(`https://vendor.test/help/${i}`));
  read.mockImplementation(async(url:string)=>url===start?success(url,links):failure(url,url.endsWith("/0")?"timeout":"http-error"));
  planner({task:"procedure",requirements:["How does a customer book?"],linkIndices:[0,1,2,3,4,5]},{followups:[[0,1,2],[0,1]]});
  const result=await collectTaskEvidence(null,start,[],{});
  expect(read).toHaveBeenCalledTimes(12);
  expect(new Set(read.mock.calls.map(([url])=>url)).size).toBe(12);
  expect(result.sources).toHaveLength(1);
  expect(result.plan.reads).toHaveLength(12);
  expect(result.plan.reads?.filter(outcome=>outcome.status==="unavailable")).toHaveLength(11);
  expect(result.plan.reads?.[1]).toMatchObject({reason:"timeout",diagnostics:{url:"https://vendor.test/help/0"}});
  expect(ask.mock.calls.filter(([operation])=>operation==="article/evidence-followup")).toHaveLength(2);
});

it("deduplicates initial URL variants and never re-reads requested or resolved destinations",async()=>{
  const requested="https://vendor.test/old-help";
  const resolved="https://vendor.test/help";
  const next="https://vendor.test/help/booking";
  read.mockImplementation(async(url:string)=>url===next?success(url):success(url,[link(`${requested}#again`),link(`${resolved}?utm_campaign=menu`),link(next)],{resolvedUrl:resolved}));
  planner({task:"procedure",requirements:["How does a customer book?"],linkIndices:[0]});
  const result=await collectTaskEvidence(null,`${requested}?utm_source=profile`,[`${requested}#serp`,requested],{});
  expect(read.mock.calls.map(([url])=>url)).toEqual([requested,next]);
  expect(result.sources.map(source=>source.url)).toEqual([resolved,next]);
  expect(result.plan.selectedUrls).toEqual([next]);
  expect(result.plan.reads).toHaveLength(2);
});

it("stops source selection when the scope review is unavailable",async()=>{
  read.mockImplementation(async(url:string)=>success(url,[link("https://vendor.test/help")]));
  planner({task:"procedure",requirements:["How does a customer book?"],linkIndices:[0]},{scopeUnavailable:true});
  const result=await collectTaskEvidence(null,"https://vendor.test/",[],{});
  expect(result.plan).toMatchObject({status:"unavailable",selectedUrls:[],requirements:[],scope:{status:"unavailable"}});
  expect(read).toHaveBeenCalledTimes(1);
  expect(ask).toHaveBeenCalledTimes(3);
});

it("retains failures and skips planning when every initial source is unavailable",async()=>{
  read.mockImplementation(async(url:string)=>failure(url,"timeout"));
  const result=await collectTaskEvidence(null,"https://vendor.test/",["https://review.test/"],{});
  expect(result).toMatchObject({sources:[],plan:{status:"unavailable",reads:[{reason:"timeout"},{reason:"timeout"}]}});
  expect(ask).not.toHaveBeenCalled();
});

it("keeps the simpler discovery collector limited to successful evidence",async()=>{
  read.mockImplementation(async(url:string)=>url==="https://vendor.test/"?success(url):routing(url,[link("https://vendor.test/help")]));
  const result=await collectDraftEvidence(null,"https://vendor.test/",["https://review.test/"]);
  expect(result.map(source=>source.url)).toEqual(["https://vendor.test/"]);
  expect(ask).not.toHaveBeenCalled();
});

it("repairs a missing promised metric before selecting sources and reselects only against the frozen checklist",async()=>{
  const start="https://project.test/",metrics="https://project.test/reports",adjacent="https://project.test/integrations";
  read.mockImplementation(async(url:string)=>success(url,url===start?[link(metrics),link(adjacent)]:[]));
  const brief={angle:"Track project milestones, metrics and centralized progress",buyingJob:"Spot blockers in real time",offering:"Integrations and automation"};
  const initial=["How are milestones set up?","How is project progress tracked centrally?"];
  const fixed=[{source:"headline",quote:"milestones",text:"Set milestones",requirementIndices:[0]},{source:"headline",quote:"metrics",text:"Use progress metrics",requirementIndices:[]},{source:"headline",quote:"centralized progress",text:"Track progress centrally",requirementIndices:[1]}].map(p=>({...p,expectedAnswer:p.text,mappingReason:"The question must request this answer explicitly."}));
  const repaired=[initial[0],"Which metrics should a small team review and what do they mean?",initial[1]];
  let scopeChecks=0,followups=0;
  ask.mockImplementation(async(operation:string)=>{
    if(operation==="article/evidence-plan")return JSON.stringify({task:"procedure",requirements:initial,linkIndices:[1]});
    if(operation==="article/approved-promises")return JSON.stringify({promises:fixed.map(({source,quote,text,expectedAnswer})=>({source,quote,text,expectedAnswer}))});
    if(operation==="article/evidence-plan-repair")return JSON.stringify({requirements:repaired});
    if(operation==="article/evidence-scope") {
      const first=scopeChecks++===0;
      const qs=first?initial:repaired;
      return scopeResponse({coverage:{complete:!first,reason:first?"Metrics omitted":"All promises covered"},promises:first?fixed:fixed.map((p,i)=>({...p,id:`p${i}`,requirementIndices:[i]})),questions:qs.map((_,requirementIndex)=>({requirementIndex,essential:true,reason:"Core task"}))});
    }
    if(operation==="article/evidence-followup")return JSON.stringify({linkIndices:followups++===0?[0]:[]});
    throw new Error(operation);
  });
  const result=await collectTaskEvidence(null,start,[],brief);
  expect(result.plan).toMatchObject({task:"procedure",status:"planned",requirements:repaired,scope:{repair:"accepted",promises:[{id:"p0",requirementIndices:[0]},{id:"p1",requirementIndices:[1]},{id:"p2",requirementIndices:[2]}]}});
  expect(read.mock.calls.map(([url])=>url)).toEqual([start,metrics]);
  const operations=ask.mock.calls.map(([operation])=>operation);
  expect(operations).toEqual(["article/evidence-plan","article/approved-promises","article/evidence-scope","article/evidence-plan-repair","article/evidence-scope","article/evidence-followup","article/evidence-followup"]);
  const followup=JSON.parse(ask.mock.calls.at(-1)![1].split("\n").at(-1));
  expect(followup.requirements).toEqual(repaired);expect(followup.brief.offering).toBeUndefined();
});
