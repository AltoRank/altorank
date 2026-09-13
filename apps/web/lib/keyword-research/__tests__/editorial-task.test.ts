import { beforeEach, expect, it, vi } from "vitest";
const {ask} = vi.hoisted(()=>({ask:vi.fn()}));
vi.mock("../buyer-model",async(original)=>({...await original<object>(),askStructured:ask}));
import {preserveEditorialTask,checkEditorialTask} from "../editorial-task";
import type {QualificationAssessment} from "../qualification-decision";
const organic=[{url:"https://ranking.test/tools",title:"Best SEO writing tools compared",description:"Compare pricing and editing features",rank:1,domain:"ranking.test",wordCount:null}];
const proposed={angle:"How editorial approval reduces liability",buyingJob:"Reduce liability"} as QualificationAssessment;
beforeEach(()=>ask.mockReset());
it("keeps an explicit rejection distinct from a provider or schema failure",async()=>{
  ask.mockResolvedValue("null");expect((await checkEditorialTask("seo writing tool",organic,proposed)).status).toBe("unsupported");
  ask.mockResolvedValue(null);expect((await checkEditorialTask("seo writing tool",organic,proposed)).status).toBe("unavailable");
});
it("uses an independent task editor and retains its exact search evidence",async()=>{
  ask.mockResolvedValue(JSON.stringify({queryTask:"Compare SEO writing tools",sourceQuote:organic[0].title,angle:"How to compare SEO writing tools",buyingJob:"Choose an SEO writing tool",reason:"Answers the selection task"}));
  const result=await preserveEditorialTask("seo writing tool",organic,proposed);
  expect(result).toMatchObject({angle:"How to compare SEO writing tools",sourceQuote:organic[0].title});
  expect(ask.mock.calls[0][0]).toBe("keyword-research/editorial-task");
  expect(ask.mock.calls[0][1]).toContain("not to promote a publisher's differentiators");
});
it("does not approve a headline when the task check is unavailable or cites invented evidence",async()=>{
  ask.mockResolvedValue(null); expect(await preserveEditorialTask("seo writing tool",organic,proposed)).toBeNull();
  ask.mockResolvedValue(JSON.stringify({queryTask:"Compare tools",sourceQuote:"An invented source",angle:"Compare tools",buyingJob:"Choose a tool",reason:"Selection"}));
  expect(await preserveEditorialTask("seo writing tool",organic,proposed)).toBeNull();
});
it("does not accept a corrected CMS task on audience overlap alone", async () => {
  ask.mockResolvedValue(JSON.stringify({queryTask:"Choose a CMS",sourceQuote:organic[0].title,angle:"How to choose a CMS",buyingJob:"Choose a CMS",reason:"Helps agencies",businessFit:{supported:false,quote:"AI content writing"}}));
  expect(await preserveEditorialTask("cms for agencies",organic,proposed,undefined,"AI content writing")).toBeNull();
});
it("requires actual evidence for the final task's offering", async () => {
  ask.mockResolvedValue(JSON.stringify({queryTask:"Compare SEO writing tools",sourceQuote:organic[0].title,angle:"How to compare SEO writing tools",buyingJob:"Choose a writing tool",reason:"Helps agencies compare writing tools",businessFit:{supported:true,quote:"AI content writing"}}));
  expect(await preserveEditorialTask("seo writing tool",organic,proposed,undefined,"AI content writing")).not.toBeNull();
  expect(await preserveEditorialTask("seo writing tool",organic,proposed,undefined,"CMS hosting")).toBeNull();
});
it("requires explicit buyer and offering fit instead of accepting a wider catalog capability",async()=>{
  const response={queryTask:"Compare HIPAA scheduling platforms",sourceIndex:0,angle:"How to compare HIPAA scheduling platforms",buyingJob:"Select a HIPAA platform",reason:"Compliance selection",businessFit:{supported:true,quote:"HIPAA scheduling"}};
  const focus={primaryBuyer:"Small teams and startups",priorityOffering:"Team scheduling software"};
  const run=()=>checkEditorialTask("hipaa scheduling",organic,proposed,undefined,"HIPAA scheduling","editorial",focus);
  ask.mockResolvedValue(JSON.stringify(response));expect((await run()).status).toBe("unavailable");
  ask.mockResolvedValue(JSON.stringify({...response,focusFit:{buyer:false,offering:true,reason:"Healthcare compliance is outside the selected buyer focus"}}));expect((await run()).status).toBe("unsupported");
  ask.mockResolvedValue(JSON.stringify({...response,focusFit:{buyer:true,offering:true,reason:"The confirmed healthcare buyer needs this offering"}}));expect((await run()).status).toBe("supported");
});
