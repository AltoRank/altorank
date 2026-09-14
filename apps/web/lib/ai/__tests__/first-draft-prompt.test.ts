import {expect,it} from "vitest";
import {buildSystemPrompt} from "../prompts";
import {buildFirstDraftPrompt} from "../first-draft-prompt";
it("keeps the selected draft on its evidence contract rather than generic SEO expansion",()=>{
 const text=buildSystemPrompt({keyword:"booking tools",title:"Compare booking tools for a two-person studio",brief:{answers:[],instructions:"UNRELATED_LEGACY_TEMPLATE"},research:{peopleAlsoAsk:["UNRELATED_PAA"]} as never,firstDraft:{task:"comparison",brief:{audience:"studio owners"},facts:[{subject:"Acme",plan:"Team",kind:"limit",sourceIndex:0,quote:"Team includes two seats",scopeQuote:"Team includes two seats",url:"https://acme.test/pricing"}],unansweredQuestions:[]}});
 expect(text).toContain("Team includes two seats");expect(text).toContain("studio owners");expect(text).not.toContain("UNRELATED_LEGACY_TEMPLATE");expect(text).not.toContain("UNRELATED_PAA");
});

it("carries the frozen promise and its validated fact mapping to the writer without changing quote scope",()=>{
 const question="How should the reader interpret the progress chart?";
 const text=buildFirstDraftPrompt({keyword:"track a project",title:"Track project progress",firstDraft:{task:"procedure",brief:{angle:"Track project progress",audience:"Small teams"},requirements:[question],promises:[{id:"p0",source:"headline",quote:"Track project progress",text:"Explain progress tracking",expectedAnswer:"Explain how the reader should interpret progress states.",mappingReason:"The question asks how to interpret the chart.",requirementIndices:[0]}],evidenceCoverage:[{question,factIndices:[1]}],facts:[{subject:"Acme",plan:"",kind:"capability",sourceIndex:0,quote:"The chart can be enabled.",scopeQuote:"",url:"https://acme.test/help"},{subject:"Acme",plan:"",kind:"explanation",sourceIndex:0,quote:"The left side represents open questions; the right side represents execution.",scopeQuote:"",url:"https://acme.test/help"}],unansweredQuestions:[]}});
 const payload=JSON.parse(text.split("\n\n").at(-1)!);
 expect(payload.articlePromises[0].requirementIndices).toEqual([0]);
 expect(payload.evidenceCoverage[0]).toEqual({question,factIndices:[1]});
 expect(payload.facts.find((f:{factIndex:number})=>f.factIndex===1).quote).toBe("The left side represents open questions; the right side represents execution.");
 expect(payload.facts[1].url).toBe("https://acme.test/help");
});
