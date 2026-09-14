import {beforeEach,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
const {ask}=vi.hoisted(()=>({ask:vi.fn()}));
vi.mock("@/lib/keyword-research/buyer-model",()=>({askStructured:ask,extractJson:(raw:string)=>{try{return JSON.parse(raw);}catch{return null;}}}));
import {checkEvidenceScope,freezeEvidenceScope,validateArticlePromises,validateEvidenceScope,validateFrozenPromises,type ArticlePromise} from "../evidence-scope";
import {ResearchBudget,withResearchBudget} from "@/lib/seo/request-context";

const brief={angle:"Find a salon and book an appointment",buyingJob:"Find and book a treatment",audience:"Salon customers"};
const questions=["How does a customer find nearby salons?","How can a customer cancel later?","What are the actual steps to book an appointment?"];
const definitions=[{source:"headline" as const,quote:"Find a salon",text:"Find a nearby salon",expectedAnswer:"Ways for a customer to find a nearby salon"},{source:"headline" as const,quote:"book an appointment",text:"Book an appointment",expectedAnswer:"The actions a customer takes to book an appointment"}].map((p,index)=>({...p,id:`p${index}`}));
const extracted=(ps=definitions)=>JSON.stringify({promises:ps.map(({id,...p})=>{void id;return p;})});
const mapped=(refs:string[][]=[["q0"],["q2"]],essential=[true,false,true])=>({coverage:{complete:refs.every(keys=>keys.length>0),reason:"Every requested action must be covered"},promises:refs.map((questionKeys,index)=>({id:`p${index}`,mappingReason:"The question requests this action",questionKeys})),questions:Object.fromEntries(essential.map((isEssential,index)=>[`q${index}`,{essential:isEssential,reason:isEssential?"Needed for the promised task":"Optional later management"}]))});
const validate=(value:unknown)=>validateEvidenceScope(JSON.stringify(value),questions,brief,definitions);
const payload=(index:number)=>JSON.parse(ask.mock.calls[index][1].split("\n").at(-1));
beforeEach(()=>vi.resetAllMocks());

it("retains exact essential questions and rebases independent promises after optional removal",()=>{
  const result=validate(mapped());
  expect(result).toMatchObject({status:"checked",requirements:[questions[0],questions[2]],omitted:[{question:questions[1]}],promises:[{...definitions[0],requirementIndices:[0]},{...definitions[1],requirementIndices:[1]}]});
  expect(validateFrozenPromises(result.promises,brief,2)).toBe(true);
});
it("derives stable question ordering from fixed keys",()=>{
  const value=mapped();value.questions=Object.fromEntries(Object.entries(value.questions).reverse());
  expect(validate(value).requirements).toEqual([questions[0],questions[2]]);
});
it.each([
  {coverage:null},{coverage:{complete:"true",reason:"Wrong type"}},{coverage:{complete:true,reason:" "}},
  {questions:[]},{questions:{q0:{essential:true,reason:"Only one checked"}}},
  {questions:{q0:{essential:true,reason:"A"},q1:{essential:false,reason:"B"},q3:{essential:true,reason:"Invented key"}}},
  {questions:{q0:{essential:"true",reason:"A"},q1:null,q2:{essential:true,reason:"C"}}},
  {promises:[]},{promises:[{...mapped().promises[0],questionKeys:["q9"]},mapped().promises[1]]},
  {promises:[{...mapped().promises[0],questionKeys:["q1"]},mapped().promises[1]]},
  {promises:[mapped().promises[0],mapped().promises[0]]},{promises:[mapped().promises[0]]},
  {promises:[{...mapped().promises[0],expectedAnswer:"An invented new answer"},mapped().promises[1]]},
  {promises:[{...mapped().promises[0],requirementIndices:[0]},mapped().promises[1]]},
  {promises:[...mapped().promises].reverse()},
])("holds missing, unknown, duplicate or altered mapping data: %j",patch=>{
  expect(validate({...mapped(),...patch})).toMatchObject({status:"unavailable",requirements:[]});
});
it.each([null,"invalid JSON"])("does not approve a missing mapping: %s",raw=>{
  expect(validateEvidenceScope(raw,questions,brief,definitions)).toEqual({status:"unavailable",requirements:[],omitted:[]});
});
it("cannot reconstruct promises from a mapper's response without prior extraction",()=>{
  expect(validateEvidenceScope(JSON.stringify(mapped()),questions,brief).status).toBe("unavailable");
});
it("requires every fixed promise even when the mapper's complete flag is true",()=>{
  const value=mapped([["q0"],[]],[true,false,false]);
  expect(validate(value)).toMatchObject({status:"unavailable",coverage:{complete:false},promises:[{id:"p0"},{id:"p1",requirementIndices:[]}]});
  value.coverage.complete=true;
  expect(validate(value)).toEqual({status:"unavailable",requirements:[],omitted:[]});
});
it("normalizes repeated references without counting them as extra evidence",()=>{
  expect(validate(mapped([["q0","q0"],["q2"]]))).toMatchObject({status:"checked",promises:[{requirementIndices:[0]},{requirementIndices:[1]}]});
});
it.each([
  null,"not JSON",JSON.stringify({promises:[]}),
  extracted([{...definitions[0],quote:"Not in the headline"}]),
  JSON.stringify({promises:[{...definitions[0],source:"buyingJob"}]}),
  JSON.stringify({promises:[{...definitions[0],questionKeys:["q0"]}]}),
  extracted([{...definitions[0],expectedAnswer:" "}]),
  extracted([definitions[0],definitions[0]]),
])("rejects malformed or untraceable independent extraction: %s",raw=>{
  expect(validateArticlePromises(raw,brief)).toBeNull();
});
it("assigns immutable IDs itself from an independently validated extraction",()=>{
  expect(validateArticlePromises(extracted(),brief)).toEqual(definitions);
});
it.each([
  (p:ArticlePromise[])=>p.slice(0,1),
  (p:ArticlePromise[])=>p.map((v,i)=>i?{...v,requirementIndices:[]}:v),
  (p:ArticlePromise[])=>p.map((v,i)=>i?{...v,id:"p0"}:v),
  (p:ArticlePromise[])=>p.map((v,i)=>i?{...v,quote:"Invented"}:v),
  (p:ArticlePromise[])=>p.map((v,i)=>i?{...v,requirementIndices:[9]}:v),
])("refuses incomplete or altered persisted mappings",alter=>{
  expect(validateFrozenPromises(alter(validate(mapped()).promises!),brief,2)).toBe(false);
});

it("extracts using only approved headline, instructions and audience before exposing planner questions",async()=>{
  const input={...brief,instructions:"Use plain language",reason:"Profitable audience",offering:"VendorOne",conversionPath:"Try VendorOne",domain:"vendorone.test",buyingJob:"Use VendorOne realtime dashboards",sourceText:"VendorOne does everything"};
  ask.mockResolvedValueOnce(extracted()).mockResolvedValueOnce(JSON.stringify(mapped()));
  const spend={supabase:{} as SupabaseClient,workspaceId:"scope-test"};
  const result=await checkEvidenceScope(input,questions,spend);
  expect(result.status).toBe("checked");
  expect(ask.mock.calls.map(c=>c[0])).toEqual(["article/approved-promises","article/evidence-scope"]);
  expect(payload(0)).toEqual({article:{angle:brief.angle,instructions:"Use plain language",audience:brief.audience}});
  expect(ask.mock.calls[0][1]).not.toContain("VendorOne");
  expect(ask.mock.calls[0][1]).not.toContain(questions[1]);
  expect(payload(1)).toEqual({article:payload(0).article,fixedPromises:definitions,questions:{q0:questions[0],q1:questions[1],q2:questions[2]}});
  for(const call of ask.mock.calls)expect(call[2]).toMatchObject({timeoutMs:30000,reasoning:"medium",spend});
});
it.each([
  {angle:"Compare platforms: automation depth, email features, and pricing",qs:["What automation depth does each supported vendor provide?","Which email features does each provide?","What does each cost?"],phrases:["automation depth","email features","pricing"],refs:[["q0"],["q1"],["q2"]]},
  {angle:"How to choose a minimalist wallet: materials, capacity, and durability tradeoffs",qs:["What materials and durability does each wallet provide?","What card/cash capacity does each provide while remaining slim?"],phrases:["materials","capacity","durability"],refs:[["q0"],["q1"],["q0"]]},
])("preserves equivalent combined coverage without a separate identity question: $angle",async({angle,qs,phrases,refs})=>{
  const ps=phrases.map((phrase,index)=>({id:`p${index}`,source:"headline" as const,quote:phrase,text:`Compare ${phrase}`,expectedAnswer:`Compare the applicable ${phrase} tradeoffs`}));
  ask.mockResolvedValueOnce(extracted(ps)).mockResolvedValueOnce(JSON.stringify(mapped(refs,qs.map(()=>true))));
  const result=await freezeEvidenceScope({angle},qs);
  expect(result.status).toBe("checked");expect(ask).toHaveBeenCalledTimes(2);
  expect(ask.mock.calls[1][1]).toContain("do not need a separate competitor-identity prerequisite");
});
it("repairs contaminated category questions once without copying the planner's vendor or metrics into promises",async()=>{
  const task={angle:"Track project progress: milestones, metrics, and centralized tools",buyingJob:"Use Basecamp to identify blockers in real time",audience:"Small teams"};
  const qs=["How are milestones created in Basecamp?","Where are Basecamp dashboards?","How does Basecamp surface real-time blockers?"];
  const ps=[{quote:"milestones",text:"Set milestones",expectedAnswer:"Concrete steps to define useful milestones"},{quote:"metrics",text:"Choose and interpret progress metrics",expectedAnswer:"Choose applicable progress measures and explain their interpretation"},{quote:"centralized tools",text:"Use centralized monitoring",expectedAnswer:"Explain how to monitor project progress centrally"}].map((p,index)=>({...p,source:"headline" as const,id:`p${index}`}));
  const repaired=["How should a team define useful milestones?","Which progress measures should a team choose and how should it interpret them?","How can a team monitor progress centrally?"];
  ask.mockResolvedValueOnce(extracted(ps)).mockResolvedValueOnce(JSON.stringify(mapped([[],[],[]],[false,false,false]))).mockResolvedValueOnce(JSON.stringify({requirements:repaired})).mockResolvedValueOnce(JSON.stringify(mapped([["q0"],["q1"],["q2"]],[true,true,true])));
  const result=await freezeEvidenceScope(task,qs);
  expect(result).toMatchObject({status:"checked",repair:"accepted",requirements:repaired,promises:ps});
  expect(ask.mock.calls.map(c=>c[0])).toEqual(["article/approved-promises","article/evidence-scope","article/evidence-plan-repair","article/evidence-scope"]);
  expect(JSON.stringify(payload(0))).not.toContain("Basecamp");
  expect(payload(2).article).toEqual({angle:task.angle,audience:task.audience});
  expect(payload(2).missingPromiseIds).toEqual(["p0","p1","p2"]);
  expect(payload(3).fixedPromises).toEqual(ps);
  expect(JSON.stringify(result.promises)).not.toContain("Basecamp");
  expect(ask.mock.calls[1][1]).toContain("Mark false if it adds a mandatory product/vendor interaction");
  expect(ask.mock.calls[2][1]).toContain("do not carry their invented scope forward");
});
it("preserves product-specific scope when the approved headline actually names it",async()=>{
  const task={angle:"Track project progress in Basecamp",audience:"Small teams"};
  const ps=[{id:"p0",source:"headline" as const,quote:task.angle,text:"Track progress in Basecamp",expectedAnswer:"The actual Basecamp actions and states for tracking progress"}];
  ask.mockResolvedValueOnce(extracted(ps)).mockResolvedValueOnce(JSON.stringify(mapped([["q0"]],[true])));
  const result=await freezeEvidenceScope(task,["Which Basecamp actions and states track project progress?"]);
  expect(result).toMatchObject({status:"checked",promises:ps});
  expect(payload(0)).toEqual({article:task});
});
it("retains the failed Basecamp shape as a regression: mapping cannot change a generic expected answer",()=>{
  const value=mapped();
  const contaminated={...value,promises:[{...value.promises[0],expectedAnswer:"Concrete steps to define milestones in Basecamp"},value.promises[1]]};
  expect(validate(contaminated)).toEqual({status:"unavailable",requirements:[],omitted:[]});
  // Isolation prevents questions influencing extraction. Semantic extraction
  // itself still needs calibration; these structural checks do not certify it.
});
it("does not start a provider call after the shared budget has already expired",async()=>{
  const result=await withResearchBudget(new ResearchBudget(0,1),()=>freezeEvidenceScope(brief,questions));
  expect(result.status).toBe("unavailable");expect(ask).not.toHaveBeenCalled();
});
it("carries the absolute time deadline from extraction into mapping",async()=>{
  const realNow=Date.now();
  const now=vi.spyOn(Date,"now").mockReturnValue(realNow);
  try {
    const budget=new ResearchBudget(30,180000);
    ask.mockImplementationOnce(async()=>{budget.reserve();now.mockReturnValue(realNow+180001);return extracted();});
    const result=await withResearchBudget(budget,()=>freezeEvidenceScope(brief,questions));
    expect(result.status).toBe("unavailable");expect(ask).toHaveBeenCalledTimes(1);
    expect(budget.deadline).toBe(realNow+180000);
  } finally {now.mockRestore();}
});
it.each([1,2,3])("does not restart the provider allowance at a later stage (calls=%s)",async(maxCalls)=>{
  const budget=new ResearchBudget(maxCalls,60000);
  const responses=[extracted(),JSON.stringify(mapped([["q0"],[]],[true,false,false])),JSON.stringify({requirements:questions})];
  ask.mockImplementation(async()=>{budget.reserve();return responses[budget.calls-1];});
  const result=await withResearchBudget(budget,()=>freezeEvidenceScope(brief,questions));
  expect(result.status).toBe("unavailable");expect(ask).toHaveBeenCalledTimes(maxCalls);expect(budget.calls).toBe(maxCalls);
});
it("does not retry malformed extraction or a failed mapping",async()=>{
  ask.mockResolvedValueOnce(null);
  expect((await freezeEvidenceScope(brief,questions)).status).toBe("unavailable");expect(ask).toHaveBeenCalledTimes(1);
  ask.mockReset();ask.mockResolvedValueOnce(extracted()).mockResolvedValueOnce(null);
  expect((await freezeEvidenceScope(brief,questions)).status).toBe("unavailable");expect(ask).toHaveBeenCalledTimes(2);
});
it.each([null,JSON.stringify({requirements:[]}),JSON.stringify({requirements:["Q?","Q?"]})])("does not retry a malformed checklist repair: %s",repair=>{
  ask.mockResolvedValueOnce(extracted()).mockResolvedValueOnce(JSON.stringify(mapped([["q0"],[]],[true,false,false]))).mockResolvedValueOnce(repair);
  return expect(freezeEvidenceScope(brief,questions)).resolves.toMatchObject({status:"unavailable",repair:"failed"}).then(()=>expect(ask).toHaveBeenCalledTimes(3));
});
it("does not repeat a semantically unsuccessful recheck or accept a dropped promise",async()=>{
  ask.mockResolvedValueOnce(extracted()).mockResolvedValueOnce(JSON.stringify(mapped([["q0"],[]],[true,false,false]))).mockResolvedValueOnce(JSON.stringify({requirements:questions})).mockResolvedValueOnce(JSON.stringify({...mapped(),promises:[mapped().promises[0]]}));
  const result=await freezeEvidenceScope(brief,questions);
  expect(result).toMatchObject({status:"unavailable",repair:"failed",promises:[{id:"p0"},{id:"p1",requirementIndices:[]}]});
  expect(ask).toHaveBeenCalledTimes(4);
});
it("retains missing booking, cost and explicit instruction obligations independently of existing questions",async()=>{
  const task={...brief,instructions:"Explain cost and the data-retention policy"};
  const ps=[...definitions,{id:"p2",source:"instructions" as const,quote:"cost",text:"Explain cost",expectedAnswer:"Explain applicable charges and conditions"},{id:"p3",source:"instructions" as const,quote:"data-retention policy",text:"Explain retention",expectedAnswer:"Explain the applicable retention policy"}];
  ask.mockResolvedValueOnce(extracted(ps)).mockResolvedValueOnce(JSON.stringify(mapped([["q0"],[],[],[]],[true])));
  const result=await checkEvidenceScope(task,[questions[0]]);
  expect(result).toMatchObject({status:"unavailable",coverage:{complete:false},promises:ps.map((p,index)=>({...p,requirementIndices:index?[]:[0]}))});
  expect(ask.mock.calls[0][1]).toContain("Conjoined actions remain separate obligations");
});
it("uses supported native schema with fixed question identities and immutable promise IDs",async()=>{
  ask.mockResolvedValueOnce(extracted()).mockResolvedValueOnce(JSON.stringify(mapped()));
  await checkEvidenceScope(brief,questions);
  const schema=ask.mock.calls[1][2].schema;
  expect(schema.properties.questions).toMatchObject({type:"object",additionalProperties:false,required:["q0","q1","q2"]});
  expect(Object.keys(schema.properties.questions.properties)).toEqual(["q0","q1","q2"]);
  expect(schema.properties.promises.items.properties.questionKeys.items.enum).toEqual(["q0","q1","q2"]);
  expect(schema.properties.promises.items.properties.id.enum).toEqual(["p0","p1"]);
  expect(schema.properties.promises.items.required).toEqual(["id","mappingReason","questionKeys"]);
  expect(schema.properties.promises.items.additionalProperties).toBe(false);
  const unsupported:string[]=[];
  const visit=(value:unknown)=>{if(!value||typeof value!=="object")return;for(const [key,child] of Object.entries(value)){if(["maxItems","uniqueItems","minimum","maximum","minLength","maxLength"].includes(key)||(key==="minItems"&&child!==0&&child!==1))unsupported.push(key);visit(child);}};
  for(const call of ask.mock.calls)visit(call[2].schema);
  expect(unsupported).toEqual([]);
});

const provenanceCases:Array<{article:Record<string,string>;sources:string[]}>= [
  {article:{angle:"Compare two newsletter tools on cost"},sources:["headline"]},
  {article:{instructions:"Compare the newsletter tools on cost"},sources:["instructions"]},
  {article:{angle:"Compare newsletter tools",instructions:"Include cost"},sources:["headline","instructions"]},
];
it.each(provenanceCases)("restricts extraction provenance to fields actually supplied: $sources",async({article,sources})=>{
  ask.mockResolvedValueOnce(null);
  await checkEvidenceScope(article,["What does each tool cost?"]);
  expect(ask.mock.calls[0][2].schema.properties.promises.items.properties.source.enum).toEqual(sources);
});
