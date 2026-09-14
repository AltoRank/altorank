import {expect,it} from "vitest";
import {validateSourceBrief,sourceBriefInstructions,type SourceFact} from "../source-brief";
import type {DraftEvidencePlan} from "../draft-evidence";
const text="Starter $9 monthly. Standard Everything in Starter, plus Marketing automation and send time optimization.";
const sources=[{url:"https://brevo.com/pricing",title:"Pricing",headings:[],text}];
const plan:DraftEvidencePlan={task:"explanation",requirements:["Which plan includes automation?"],status:"planned",selectedUrls:[],retrievedUrls:[]};
const fact:SourceFact={subject:"Brevo",plan:"Standard",kind:"capability",statement:"Brevo Standard includes marketing automation.",sourceIndex:0,quote:"Marketing automation and send time optimization.",scopeQuote:"Standard Everything in Starter, plus Marketing automation and send time optimization."};
const raw=(facts:SourceFact[],indices=[0])=>JSON.stringify({facts,coverage:[{requirementIndex:0,factIndices:indices}]});
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
 expect(validateSourceBrief(JSON.stringify({facts:[{...f,scopeStart:"Standard Everything in Starter"}],coverage:[{requirementIndex:0,factIndices:[0]}]}),sources,plan,"Brevo").status).toBe("prepared");
 expect(validateSourceBrief(JSON.stringify({facts:[{...f,scopeStart:" "}],coverage:[{requirementIndex:0,factIndices:[0]}]}),sources,plan,"Brevo").facts).toHaveLength(0);
});

it("allows two source-backed plan options when the task compares plans, and refuses duplicate fact sets",()=>{
 const starter={...fact,plan:"Starter",kind:"price" as const,statement:"Starter is $9 monthly.",quote:"$9 monthly.",scopeQuote:"Starter $9 monthly."};
 const input={facts:[starter,fact],coverage:[{requirementIndex:0,factIndices:[0,1]}],options:[{label:"Starter",factIndices:[0]},{label:"Standard",factIndices:[1]}]};
 expect(validateSourceBrief(JSON.stringify(input),sources,{...plan,task:"comparison",comparisonType:"plans"},"Brevo").status).toBe("prepared");
 input.options[1].factIndices=[0];
 expect(validateSourceBrief(JSON.stringify(input),sources,{...plan,task:"comparison",comparisonType:"plans"},"Brevo").status).toBe("insufficient");
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
