import {afterEach,expect,it,vi} from "vitest";
import * as buyerModel from "@/lib/keyword-research/buyer-model";
afterEach(()=>vi.restoreAllMocks());
import {validateSourceBrief,prepareSourceBrief,attachSourceReadiness,sourceBriefInstructions,type SourceFact} from "../source-brief";
import type {DraftEvidencePlan} from "../draft-evidence";
const text="Starter $9 monthly. Standard Everything in Starter, plus Marketing automation and send time optimization.";
const sources=[{url:"https://brevo.com/pricing",title:"Pricing",headings:[],text}];
const plan:DraftEvidencePlan={task:"explanation",requirements:["Which plan includes automation?"],status:"planned",selectedUrls:[],retrievedUrls:[]};
const fact:SourceFact={subject:"Brevo",plan:"Standard",kind:"capability",statement:"Brevo Standard includes marketing automation.",sourceIndex:0,quote:"Marketing automation and send time optimization.",scopeQuote:"Standard Everything in Starter, plus Marketing automation and send time optimization."};
const wire=(input:{facts:Array<Partial<SourceFact>&{scopeStart?:string}>;coverage:Array<{requirementIndex:number;factIndices:number[]}>;options?:Array<{label:string;factIndices:number[]}>})=>JSON.stringify({
 facts:input.facts.map((f,i)=>({...f,id:`fact_${i}`})),
 coverage:input.coverage.map(c=>({requirementIndex:c.requirementIndex,factIds:c.factIndices.map(i=>`fact_${i}`)})),
 options:input.options?.map(o=>({label:o.label,factIds:o.factIndices.map(i=>`fact_${i}`)})),
});
const raw=(facts:SourceFact[],indices=[0])=>wire({facts,coverage:[{requirementIndex:0,factIndices:indices}]});
it("keeps a plan-bound capability with its exact source section",()=>{
 const result=validateSourceBrief(raw([fact]),sources,plan,"Brevo");
 expect(result.status).toBe("prepared");expect(result.facts[0]).toMatchObject({plan:"Standard",url:sources[0].url});
});
it("rejects assigning higher-tier additions to the inherited lower plan",()=>{
 const wrong={...fact,plan:"Starter",scopeQuote:"Starter, plus Marketing automation and send time optimization."};
 // A dangling inherited-plan label cannot establish a plan section either.
 expect(validateSourceBrief(raw([{...wrong,scopeQuote:"Starter Everything in Starter, plus Marketing automation and send time optimization."}]),sources,plan,"Brevo").status).not.toBe("prepared");
 const inherited={...fact,plan:"Starter",scopeQuote:text};
 expect(validateSourceBrief(raw([inherited]),sources,plan,"Brevo").status).not.toBe("prepared");
});
it("does not count untraceable facts as answered evidence questions",()=>{
 const result=validateSourceBrief(raw([{...fact,quote:"Unlimited automation in Starter"}]),sources,plan,"Brevo");
 expect(result.facts).toHaveLength(0);expect(result.coverage[0].factIndices).toEqual([]);
});
it.each([true,false])("separates manufacturer attribution from readiness for the frozen task (applicable=%s)",async(applicable)=>{
 const angle=applicable?"How to wash wool shoes, with a Merinos example":"How to wash Allbirds shoes";
 const question=applicable?"How does Merinos advise washing its shoes?":"How does Allbirds advise washing its shoes?";
 const procedure={...fact,subject:"Merinos",plan:"",kind:"procedure" as const,quote:"Wash in cold water.",scopeQuote:"",statement:"Wash Merinos in cold water."};
 const promises=[{id:"p0",source:"headline" as const,quote:angle,text:angle,expectedAnswer:question,mappingReason:"The question covers the washing guidance.",requirementIndices:[0]}];
 const task={...plan,task:"procedure" as const,requirements:[question],scope:{status:"checked" as const,requirements:[question],omitted:[],promises}};
 const pages=[{...sources[0],url:"https://merinos.com/care",text:procedure.quote}];
 const ask=vi.spyOn(buyerModel,"askStructured").mockResolvedValueOnce(raw([procedure])).mockResolvedValueOnce(JSON.stringify({questions:[{requirementIndex:0,answered:applicable,reason:applicable?"Manufacturer guidance for the named example.":"Merinos instructions cannot establish Allbirds care."}],promises:[{promiseId:"p0",answered:applicable,reason:applicable?"The named example is supported.":"The approved named product is not supported."}]}));
 expect(validateSourceBrief(raw([procedure]),pages,task,"Allbirds").status).toBe("prepared");
 const result=await prepareSourceBrief(pages,task,{angle},"Allbirds");
 expect(ask).toHaveBeenCalledTimes(2);
 expect(result.status).toBe(applicable?"prepared":"insufficient");
});
it("refuses a competitor review as primary vendor pricing evidence",()=>{
 expect(validateSourceBrief(raw([fact]),[{...sources[0],url:"https://review.test/brevo"}],plan,"Brevo").status).not.toBe("prepared");
});
it("does not treat one vendor's care instructions as applicable to another",()=>{
 const procedure={...fact,subject:"Merinos",plan:"",kind:"procedure" as const,quote:"Wash in cold water.",scopeQuote:"",statement:"Wash Merinos in cold water."};
 const pages=[{...sources[0],url:"https://merinos.com/care",text:procedure.quote}];
 expect(validateSourceBrief(raw([procedure]),pages,{...plan,task:"procedure"},"Allbirds").status).toBe("insufficient");
 expect(validateSourceBrief(raw([{...procedure,scopeQuote:procedure.quote}]),pages,{...plan,task:"procedure"},"Merinos").status).toBe("prepared");
});
it("keeps missing requirements visible and refuses a one-vendor comparison",()=>{
 expect(validateSourceBrief(raw([fact],[]),sources,plan,"Brevo").status).toBe("insufficient");
 expect(validateSourceBrief(raw([fact]),sources,{...plan,task:"comparison"},"Brevo").status).toBe("insufficient");
 expect(validateSourceBrief(raw([fact]),sources,{...plan,status:"unavailable",requirements:[]},"Brevo").status).toBe("unavailable");
});

it("preserves traceable facts when another proposed supporting fact is discarded",()=>{
 const result=validateSourceBrief(raw([fact,{...fact,quote:"An invented feature"}],[0,1]),sources,plan,"Brevo");
 expect(result.coverage[0].factIndices).toEqual([0]);expect(result.facts).toHaveLength(1);
});
it("reconstructs a short exact plan anchor and rejects a blank anchor",()=>{
 const {scopeQuote,...f}=fact;void scopeQuote;
 expect(validateSourceBrief(wire({facts:[{...f,scopeStart:"Standard Everything in Starter"}],coverage:[{requirementIndex:0,factIndices:[0]}]}),sources,plan,"Brevo").status).toBe("prepared");
 expect(validateSourceBrief(wire({facts:[{...f,scopeStart:" "}],coverage:[{requirementIndex:0,factIndices:[0]}]}),sources,plan,"Brevo").facts).toHaveLength(0);
});

it("allows two source-backed plan options when the task compares plans, and refuses duplicate fact sets",()=>{
 const starter={...fact,plan:"Starter",kind:"price" as const,statement:"Starter is $9 monthly.",quote:"$9 monthly.",scopeQuote:"Starter $9 monthly."};
 const input={facts:[starter,fact],coverage:[{requirementIndex:0,factIndices:[0,1]}],options:[{label:"Starter",factIndices:[0]},{label:"Standard",factIndices:[1]}]};
 expect(validateSourceBrief(wire(input),sources,{...plan,task:"comparison",comparisonType:"plans"},"Brevo").status).toBe("prepared");
 input.options[1].factIndices=[0];
 expect(validateSourceBrief(wire(input),sources,{...plan,task:"comparison",comparisonType:"plans"},"Brevo").status).toBe("insufficient");
});

it("gives the writer the exact quote and scope rather than an unverified paraphrase",()=>{
 const result=validateSourceBrief(raw([{...fact,statement:"An invented extra feature"}]),sources,plan,"Brevo");
 const prompt=sourceBriefInstructions(result);
 expect(prompt).toContain(fact.quote);expect(prompt).not.toContain("An invented extra feature");
});

it("does not count aliases on one vendor's domain as separate vendors",()=>{
 const input=raw([fact,{...fact,subject:"Brevo Platform"}],[0,1]);
 expect(validateSourceBrief(input,sources,{...plan,task:"comparison",comparisonType:"vendors"},"Brevo").status).toBe("insufficient");
});
it("does not bind a Professional feature to a distinct Pro plan",()=>{
 const f={...fact,plan:"Pro",quote:"Automation included.",scopeQuote:"Professional Automation included."};
 expect(validateSourceBrief(raw([f]),[{...sources[0],text:f.scopeQuote}],plan,"Brevo").facts).toHaveLength(0);
});

it("requires every core question, not one answered question among missing ones",()=>{
 const result=validateSourceBrief(raw([fact]),sources,{...plan,requirements:[...plan.requirements,"What does that plan cost?"]},"Brevo");
 expect(result.status).toBe("insufficient");expect(result.coverage[1].factIndices).toEqual([]);
});
it("requires the same two vendors to cover every comparison criterion",()=>{
 const pages=[...sources,{...sources[0],url:"https://acme.test/pricing",text:"Team $12 monthly. Team includes automation."}];
 const otherPrice={...fact,subject:"Acme",plan:"Team",kind:"price" as const,sourceIndex:1,quote:"$12 monthly.",scopeQuote:"Team $12 monthly."};
 const otherFeature={...otherPrice,kind:"capability" as const,quote:"automation.",scopeQuote:"Team includes automation."};
 const ownPrice={...fact,kind:"price" as const,plan:"Starter",quote:"$9 monthly.",scopeQuote:"Starter $9 monthly."};
 const facts=[fact,ownPrice,otherPrice,otherFeature];
 const input={facts,options:[{label:"Brevo",factIndices:[0,1]},{label:"Acme",factIndices:[2,3]}],coverage:[{requirementIndex:0,factIndices:[0,3]},{requirementIndex:1,factIndices:[1]}]};
 const comparison={...plan,task:"comparison" as const,comparisonType:"vendors" as const,requirements:["Automation?","Price?"]};
 expect(validateSourceBrief(wire(input),pages,comparison,"Brevo").status).toBe("insufficient");
 input.coverage[1].factIndices.push(2);
 const result=validateSourceBrief(wire(input),pages,comparison,"Brevo");
 expect(result.status).toBe("prepared");expect(result.options?.map(o=>o.label)).toEqual(["Brevo","Acme"]);
 input.options[1].factIndices=[0,1];
 expect(validateSourceBrief(wire(input),pages,comparison,"Brevo").status).toBe("insufficient");
});

it("traceable quotes are not readiness when they fail to answer the essential question",()=>{
 const brief=validateSourceBrief(raw([fact]),sources,plan,"Brevo");
 expect(attachSourceReadiness(brief,JSON.stringify({questions:[{requirementIndex:0,answered:false,reason:"The source describes a different workflow."}]})).status).toBe("insufficient");
 expect(attachSourceReadiness(brief,JSON.stringify({questions:[{requirementIndex:0,answered:true,reason:"The named plan explicitly includes automation."}]})).status).toBe("prepared");
 expect(attachSourceReadiness(brief,JSON.stringify({questions:[]})).status).toBe("unavailable");
 expect(attachSourceReadiness(brief,null).status).toBe("unavailable");
});


it("references explicit fact ids after filtering and reordering, without guessing positions",()=>{
 const other={...fact,id:"breathability",plan:"",quote:"Starter $9 monthly.",scopeQuote:"",statement:"Starter is $9 monthly."};
 const input={facts:[{...fact,id:"invalid",quote:"Invented"},other,{...fact,id:"automation"}],coverage:[{requirementIndex:0,factIds:["automation"]}]};
 const result=validateSourceBrief(JSON.stringify(input),sources,plan,"Brevo");
 expect(result.status).toBe("prepared");expect(result.coverage[0].factIndices).toEqual([1]);
 expect(result.facts[result.coverage[0].factIndices[0]].quote).toBe(fact.quote);
 input.facts.reverse();
 const reordered=validateSourceBrief(JSON.stringify(input),sources,plan,"Brevo");
 expect(reordered.coverage[0].factIndices).toEqual([0]);
 expect(reordered.facts[0].quote).toBe(fact.quote);
});

it("rejects absent or duplicate ids and leaves unknown references unanswered",()=>{
 for(const facts of [[fact],[{...fact,id:"same"},{...fact,id:"same"}]]) {
  expect(validateSourceBrief(JSON.stringify({facts,coverage:[{requirementIndex:0,factIds:["same"]}]}),sources,plan,"Brevo").status).toBe("unavailable");
 }
 const result=validateSourceBrief(JSON.stringify({facts:[{...fact,id:"f1"}],coverage:[{requirementIndex:0,factIds:["f0"]}]}),sources,plan,"Brevo");
 expect(result.status).toBe("insufficient");expect(result.coverage[0].factIndices).toEqual([]);
});

it("does not carry model-suggested comparison options into an explanation",()=>{
 const result=validateSourceBrief(wire({facts:[fact],coverage:[{requirementIndex:0,factIndices:[0]}],options:[{label:"Brevo",factIndices:[0]}]}),sources,plan,"Brevo");
 expect(result.status).toBe("prepared");expect(result.options).toBeUndefined();
 expect(sourceBriefInstructions(result,"explanation")).not.toContain("Choose just TWO");
 expect(sourceBriefInstructions(result,"procedure")).not.toContain("Choose just TWO");
 expect(sourceBriefInstructions(result,"comparison")).toContain("Choose just TWO");
});

it.each(["explanation","comparison","procedure"] as const)("passes the actual %s answer form to evidence extraction",async(task)=>{
 const ask=vi.spyOn(buyerModel,"askStructured").mockResolvedValueOnce(JSON.stringify({facts:[],coverage:[]}));
 await prepareSourceBrief(sources,{...plan,task,comparisonType:"plans"},{angle:"An approved article"},"Brevo");
 const payload=JSON.parse(ask.mock.calls[0][1].split("\n").at(-1)!);
 expect(payload.researchTask).toBe(task);
 expect(payload.comparisonType).toBe(task==="comparison"?"plans":undefined);
 expect(ask.mock.calls[0][1]).toContain('"factIds":[string]');
});

it("labels validated facts explicitly for the independent coverage reviewer",async()=>{
 const ask=vi.spyOn(buyerModel,"askStructured").mockResolvedValueOnce(raw([fact])).mockResolvedValueOnce(JSON.stringify({questions:[{requirementIndex:0,answered:true,reason:"Directly states automation."}],promises:[{promiseId:"p0",answered:true,reason:"The quote identifies the applicable plan."}]}));
 const result=await prepareSourceBrief(sources,plan,{angle:"An approved article"},"Brevo");
 expect(result.status).toBe("prepared");
 const payload=JSON.parse(ask.mock.calls[1][1].split("\n").at(-1)!);
 expect(payload.facts[0].factIndex).toBe(0);expect(payload.requirements[0].factIndices).toEqual([0]);
 expect(payload.facts[0].statement).toBeUndefined();
});

it("prepares the frozen headline promise without turning broad product positioning into extra evidence requirements",async()=>{
 const ask=vi.spyOn(buyerModel,"askStructured").mockResolvedValueOnce(raw([fact])).mockResolvedValueOnce(JSON.stringify({questions:[{requirementIndex:0,answered:true,reason:"Directly states automation."}],promises:[{promiseId:"p0",answered:true,reason:"The quote identifies the applicable plan."}]}));
 const promises=[{id:"p0",source:"headline" as const,quote:"automation",text:"Explain automation",expectedAnswer:"Identify the plan that includes automation.",mappingReason:"The question asks which plan includes automation.",requirementIndices:[0]}];
 await prepareSourceBrief(sources,{...plan,scope:{status:"checked",requirements:plan.requirements,omitted:[],promises}},
   {angle:"Explain automation",buyingJob:"Manage marketing",audience:"Small teams",instructions:"Keep the plan distinction",reason:"UNBOUNDED_QUALIFICATION_REASON",offering:"UNBOUNDED_PRODUCT_CATALOGUE",conversionPath:"UNBOUNDED_CONVERSION_COPY"},"Brevo");
 const extraction=JSON.parse(ask.mock.calls[0][1].split("\n").at(-1)!);
 const readiness=JSON.parse(ask.mock.calls[1][1].split("\n").at(-1)!);
 expect(extraction.promises).toEqual(promises);
 expect(extraction.task).toEqual({angle:"Explain automation",buyingJob:"Manage marketing",audience:"Small teams",instructions:"Keep the plan distinction"});
 expect(readiness.task).toEqual(extraction.task);
 expect(readiness.promises).toEqual(promises);
 expect(ask.mock.calls[1][2].schema).toMatchObject({required:["questions","promises"],properties:{promises:{items:{required:["promiseId","answered","reason"],properties:{promiseId:{enum:["p0"]}}}}}});
 expect(ask.mock.calls.map(c=>c[1]).join(" ")).not.toContain("UNBOUNDED_");
});

it("does not approve a broad question when its mapped headline promise remains unanswered",()=>{
 const prepared=validateSourceBrief(raw([fact]),sources,plan,"Brevo");
 const promises=[{id:"p0",source:"headline" as const,quote:"automation",text:"Explain automation",expectedAnswer:"Identify the plan and applicable limit.",mappingReason:"The question asks about automation availability.",requirementIndices:[0]}];
 const questions=[{requirementIndex:0,answered:true,reason:"A plan is named."}];
 expect(attachSourceReadiness(prepared,JSON.stringify({questions}),promises).status).toBe("unavailable");
 expect(attachSourceReadiness(prepared,JSON.stringify({questions,promises:[{promiseId:"p0",answered:false,reason:"The required limit is not established."}]}),promises).status).toBe("insufficient");
 expect(attachSourceReadiness(prepared,JSON.stringify({questions,promises:[{promiseId:"another",answered:true,reason:"A different answer."}]}),promises).status).toBe("unavailable");
 expect(attachSourceReadiness(prepared,JSON.stringify({questions,promises:[{id:"p0",answered:true,reason:"Wrong wire identity."}]}),promises).status).toBe("unavailable");
});
