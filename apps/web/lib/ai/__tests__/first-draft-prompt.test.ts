import {expect,it} from "vitest";
import {buildSystemPrompt} from "../prompts";
it("keeps the selected draft on its evidence contract rather than generic SEO expansion",()=>{
 const text=buildSystemPrompt({keyword:"booking tools",title:"Compare booking tools for a two-person studio",brief:{answers:[],instructions:"UNRELATED_LEGACY_TEMPLATE"},research:{peopleAlsoAsk:["UNRELATED_PAA"]} as never,firstDraft:{task:"comparison",brief:{audience:"studio owners"},facts:[{subject:"Acme",plan:"Team",kind:"limit",sourceIndex:0,quote:"Team includes two seats",scopeQuote:"Team includes two seats",url:"https://acme.test/pricing"}],unansweredQuestions:[]}});
 expect(text).toContain("Team includes two seats");expect(text).toContain("studio owners");expect(text).not.toContain("UNRELATED_LEGACY_TEMPLATE");expect(text).not.toContain("UNRELATED_PAA");
});
