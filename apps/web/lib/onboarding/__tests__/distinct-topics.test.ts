import {ResearchBudget,currentResearchBudget} from "@/lib/seo/request-context";
import {beforeEach,expect,it,vi} from "vitest";
const {ask}=vi.hoisted(()=>({ask:vi.fn()}));
let observedBudget:ResearchBudget|undefined;
vi.mock("@/lib/keyword-research/buyer-model",()=>({askStructured:(...args:unknown[])=>{observedBudget=currentResearchBudget();return ask(...args);},extractJson:(raw:string)=>{try{return JSON.parse(raw);}catch{return null;}}}));
import {distinctOnboardingTopics,topicRepresentatives} from "../distinct-topics";
import type {KeywordRecommendation} from "@/lib/seo/recommendations";
import {OPPORTUNITY_VERSION} from "@/lib/keyword-research/opportunity";
beforeEach(()=>ask.mockReset());
const decision=(groups:number[][],kinds:string[]=Array.from({length:groups.flat().length},()=>"selection"))=>JSON.stringify({groups,answerKinds:kinds.map((kind,topicIndex)=>({topicIndex,kind}))});
it("keeps the highest-ranked representative of every complete task group",()=>{
  expect(topicRepresentatives(decision([[2,0],[3],[1]]),4)).toEqual([0,1,3]);
});
it.each(['{"groups":[[0],[0]]}','{"groups":[[0],[2]]}','{"groups":[[0]]}','{"groups":[[],[0,1]]}','{"groups":[[0,1.5]]}','{}','null'])("rejects incomplete or fabricated partitions %s",raw=>{
  expect(topicRepresentatives(JSON.stringify({...JSON.parse(raw),answerKinds:[{topicIndex:0,kind:"selection"},{topicIndex:1,kind:"selection"}]}),2)).toBeNull();
});
const recs=Array.from({length:3},(_,i)=>({keywordId:String(i),term:["scheduling software","calendar booking tools","payment scheduling"][i],action:"write",quality:"ok",opportunity:{version:OPPORTUNITY_VERSION,status:"qualified",angle:"Compare options",buyingJob:"Choose a scheduling tool"}})) as KeywordRecommendation[];
it("removes variations without changing original eligibility or ranking",async()=>{
  ask.mockResolvedValue(decision([[1,0],[2]]));
  const result=await distinctOnboardingTopics(recs);
  expect(result).toEqual([recs[0],recs[2]]);expect(recs).toHaveLength(3);
});
it("keeps one qualified option rather than filling a calendar after an unavailable check",async()=>{
  ask.mockResolvedValue(null);
  expect(await distinctOnboardingTopics(recs)).toEqual([recs[0]]);
});
it("never promotes unqualified candidates or pays for a single option",async()=>{
  expect(await distinctOnboardingTopics([{...recs[0],opportunity:undefined}])).toEqual([]);
  expect(await distinctOnboardingTopics([recs[0]])).toEqual([recs[0]]);expect(ask).not.toHaveBeenCalled();
});
it("remembers rejected synonyms when the month is extended later",async()=>{
  const inputs=structuredClone(recs);
  ask.mockResolvedValue(decision([[0,1],[2]]));
  const originalEvidence=inputs.map(rec=>structuredClone(rec.opportunity));
  const rpc=vi.fn(async()=>({data:true,error:null}));
  await distinctOnboardingTopics(inputs,{supabase:{rpc} as never,workspaceId:"site-a"});
  expect(rpc.mock.calls).toHaveLength(3);
  for (const [index,taskKey] of ["0","0","2"].entries()) expect(rpc).toHaveBeenNthCalledWith(index+1,"save_onboarding_task_group",{
    p_workspace:"site-a",p_keyword:String(index),p_expected:originalEvidence[index],p_task_key:taskKey,
  });
  ask.mockClear();
  expect(await distinctOnboardingTopics(inputs.slice(0,2))).toEqual([inputs[0]]);
  expect(ask).not.toHaveBeenCalled();
});

it("sends a large legacy snapshot in the RPC body and preserves a concurrent update",async()=>{
  const inputs=structuredClone(recs.slice(0,2));
  inputs[0].opportunity={...inputs[0].opportunity!,reason:"Evidence ".repeat(3000)};
  ask.mockResolvedValue(decision([[0,1]]));
  const rpc=vi.fn(async()=>({data:false,error:null}));
  await distinctOnboardingTopics(inputs,{supabase:{rpc} as never,workspaceId:"site-a"});
  expect(rpc).toHaveBeenCalledWith("save_onboarding_task_group",expect.objectContaining({p_expected:inputs[0].opportunity}));
  expect(inputs.every(rec=>!rec.opportunity?.taskKey)).toBe(true);
});

it("shares the caller's qualification budget and strips transient diagnostics from the stored comparison",async()=>{
 const budget=new ResearchBudget(65,110000);const inputs=structuredClone(recs.slice(0,2));
 inputs[0].opportunity!.qualificationRun={checked:3,distinct:2,stopped:"exhausted",calls:8,costUsd:0.1};
 ask.mockResolvedValue(decision([[0,1]]));
 const rpc=vi.fn(async()=>({data:true,error:null}));
 await distinctOnboardingTopics(inputs,{supabase:{rpc} as never,workspaceId:"site-a"},budget);
 expect(observedBudget).toBe(budget);
 expect(rpc).toHaveBeenCalledWith("save_onboarding_task_group",expect.objectContaining({p_expected:expect.not.objectContaining({qualificationRun:expect.anything()})}));
});

it.each([undefined,[],[{topicIndex:0,kind:"selection"},{topicIndex:0,kind:"procedure"}],[{topicIndex:0,kind:"selection"},{topicIndex:1,kind:"unknown"}]])("rejects missing or invalid answer classifications: %j",answerKinds=>{
  expect(topicRepresentatives(JSON.stringify({groups:[[0,1]],answerKinds}),2)).toBeNull();
});
it("splits a comparison and a how-to before persisting their task identities",async()=>{
  const inputs=structuredClone(recs.slice(0,2));
  inputs[0].term="compare project tools";
  inputs[0].opportunity!.taskReview={queryTask:"Choose between two project tools",angle:"Compare project tools",buyingJob:"Select a tool",reason:"Relevant",sourceQuote:"Comparison",supportingResultIndices:[0,1]};
  inputs[1].term="centralize communication";
  inputs[1].opportunity!.angle="How to centralize team communication";
  inputs[1].opportunity!.buyingJob="Move scattered conversations into one workflow";
  ask.mockResolvedValue(decision([[0,1]],["selection","procedure"]));
  const rpc=vi.fn<(name:string,args:Record<string,unknown>)=>Promise<{data:boolean;error:null}>>().mockResolvedValue({data:true,error:null});
  expect(await distinctOnboardingTopics(inputs,{supabase:{rpc} as never,workspaceId:"site-a"})).toEqual(inputs);
  expect(rpc.mock.calls.map(call=>call[1].p_task_key)).toEqual(["0","1"]);
  expect(inputs.map(rec=>rec.opportunity?.taskKey)).toEqual(["0","1"]);
  const payload=JSON.parse(ask.mock.calls[0][1].split("\n").at(-1));
  expect(payload.topics[0].queryTask).toBe("Choose between two project tools");
});
it("rechecks legacy task aliases instead of silently preserving an old mixed-task merge",async()=>{
  const inputs=structuredClone(recs.slice(0,2));
  for(const rec of inputs)Object.assign(rec.opportunity!,{version:OPPORTUNITY_VERSION-1,taskKey:"0"});
  ask.mockResolvedValue(decision([[0,1]],["selection","procedure"]));
  const rpc=vi.fn<(name:string,args:Record<string,unknown>)=>Promise<{data:boolean;error:null}>>().mockResolvedValue({data:true,error:null});
  expect(await distinctOnboardingTopics(inputs,{supabase:{rpc} as never,workspaceId:"site-a"})).toHaveLength(2);
  expect(ask).toHaveBeenCalledOnce();
  expect(rpc.mock.calls.map(call=>call[1].p_task_key)).toEqual(["0","1"]);
});
