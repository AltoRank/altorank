import { beforeEach, expect, it, vi } from "vitest";
const {ask} = vi.hoisted(()=>({ask:vi.fn()}));
vi.mock("../buyer-model",async(original)=>({...await original<object>(),askStructured:ask}));
import {preserveEditorialTask,checkEditorialTask} from "../editorial-task";
import type {QualificationAssessment} from "../qualification-decision";
const organic=[
  {url:"https://ranking.test/tools",title:"Best SEO writing tools compared",description:"Compare pricing and editing features",rank:1,domain:"ranking.test",wordCount:null},
  {url:"https://other.test/tools",title:"How small teams should compare content writing tools",description:"Compare writing workflow and costs",rank:2,domain:"other.test",wordCount:null},
  {url:"https://app.test/writing",title:"Download the writing app",description:"A writing app",rank:3,domain:"app.test",wordCount:null},
];
const relevance={buyer:true,task:true,reason:"Small teams choosing a writing tool"};
const proposed={angle:"How editorial approval reduces liability",buyingJob:"Reduce liability",results:organic.map((row,resultIndex)=>({resultIndex,url:row.url,format:resultIndex===2?"product":"article",evidenceField:"title",quote:row.title,relevance}))} as QualificationAssessment;
const supportingResults=[0,1].map(resultIndex=>({resultIndex,relevance}));
const supported={status:"supported",queryTask:"Compare SEO writing tools",supportingResults,angle:"How to compare SEO writing tools",buyingJob:"Choose an SEO writing tool",reason:"Answers the selection task"};
beforeEach(()=>ask.mockReset());
it("keeps an explicit rejection distinct from a provider or schema failure",async()=>{
  ask.mockResolvedValue("null");expect((await checkEditorialTask("seo writing tool",organic,proposed)).status).toBe("unsupported");
  ask.mockResolvedValue(null);expect((await checkEditorialTask("seo writing tool",organic,proposed)).status).toBe("unavailable");
});
it("uses an independent task editor and binds the final task to relevant article indices",async()=>{
  ask.mockResolvedValue(JSON.stringify(supported));
  const result=await preserveEditorialTask("seo writing tool",organic,proposed);
  expect(result).toMatchObject({angle:"How to compare SEO writing tools",sourceQuote:organic[0].title,supportingResultIndices:[0,1]});
  expect(ask.mock.calls[0][0]).toBe("keyword-research/editorial-task");
  expect(ask.mock.calls[0][1]).toContain("not to promote a publisher's differentiators");
  const input=JSON.parse(ask.mock.calls[0][1].split("\n").at(-1));
  expect(input.eligibleArticleIndices).toEqual([0,1]);
});
it("does not approve a headline when the task check is unavailable or cites invented evidence",async()=>{
  ask.mockResolvedValue(null); expect(await preserveEditorialTask("seo writing tool",organic,proposed)).toBeNull();
  ask.mockResolvedValue(JSON.stringify({...supported,supportingResults:[{resultIndex:99,relevance},{resultIndex:1,relevance}]}));
  expect(await preserveEditorialTask("seo writing tool",organic,proposed)).toBeNull();
});
it("does not accept a corrected CMS task on audience overlap alone", async () => {
  ask.mockResolvedValue(JSON.stringify({...supported,queryTask:"Choose a CMS",angle:"How to choose a CMS",buyingJob:"Choose a CMS",reason:"Helps agencies",businessFit:{supported:false,quote:"AI content writing"}}));
  expect(await preserveEditorialTask("cms for agencies",organic,proposed,undefined,"AI content writing")).toBeNull();
});
it("requires actual evidence for the final task's offering", async () => {
  ask.mockResolvedValue(JSON.stringify({...supported,businessFit:{supported:true,quote:"AI content writing"}}));
  expect(await preserveEditorialTask("seo writing tool",organic,proposed,undefined,"AI content writing")).not.toBeNull();
  expect(await preserveEditorialTask("seo writing tool",organic,proposed,undefined,"CMS hosting")).toBeNull();
});
it("requires explicit buyer and offering fit instead of accepting a wider catalog capability",async()=>{
  const response={...supported,queryTask:"Compare HIPAA scheduling platforms",angle:"How to compare HIPAA scheduling platforms",buyingJob:"Select a HIPAA platform",reason:"Compliance selection",businessFit:{supported:true,quote:"HIPAA scheduling"}};
  const focus={primaryBuyer:"Small teams and startups",priorityOffering:"Team scheduling software"};
  const run=()=>checkEditorialTask("hipaa scheduling",organic,proposed,undefined,"HIPAA scheduling","editorial",focus);
  ask.mockResolvedValue(JSON.stringify(response));expect((await run()).status).toBe("unavailable");
  ask.mockResolvedValue(JSON.stringify({...response,focusFit:{buyer:false,offering:true,reason:"Healthcare compliance is outside the selected buyer focus"}}));expect((await run()).status).toBe("unsupported");
  ask.mockResolvedValue(JSON.stringify({...response,focusFit:{buyer:true,offering:true,reason:"The confirmed healthcare buyer needs this offering"}}));expect((await run()).status).toBe("supported");
});
it("cannot switch from article evidence to an app store result for the final headline",async()=>{
  ask.mockResolvedValue(JSON.stringify({...supported,supportingResults:[{resultIndex:0,relevance},{resultIndex:2,relevance}]}));
  expect((await checkEditorialTask("seo writing tool",organic,proposed)).status).toBe("unavailable");
});
it.each([
  undefined,
  [{resultIndex:0,relevance}],
  [{resultIndex:0,relevance},{resultIndex:0,relevance}],
  [{resultIndex:0,relevance},{resultIndex:1}],
  [{resultIndex:0,relevance},{resultIndex:1,relevance:{buyer:true,task:"true",reason:"Same task"}}],
])("requires complete distinct final-angle support: %j",async(results)=>{
  ask.mockResolvedValue(JSON.stringify({...supported,supportingResults:results}));
  expect((await checkEditorialTask("seo writing tool",organic,proposed)).status).toBe("unavailable");
});
it("rejects an editor's explicit final-task mismatch",async()=>{
  ask.mockResolvedValue(JSON.stringify({...supported,supportingResults:[{resultIndex:0,relevance},{resultIndex:1,relevance:{buyer:true,task:false,reason:"This supports a different task"}}]}));
  expect((await checkEditorialTask("seo writing tool",organic,proposed)).status).toBe("unsupported");
});
it("does not reapprove a consumer task using development articles",async()=>{
  const invalid={...proposed,results:proposed.results.map(row=>({...row,relevance:{buyer:false,task:false,reason:"Development agency audience"}}))};
  expect((await checkEditorialTask("beauty appointment app",organic,invalid)).status).toBe("unsupported");
  expect(ask).not.toHaveBeenCalled();
});
it("reports a missing qualification contract as unavailable instead of a topic rejection",async()=>{
  expect((await checkEditorialTask("seo writing tool",organic,{angle:proposed.angle} as QualificationAssessment)).status).toBe("unavailable");
  expect(ask).not.toHaveBeenCalled();
});
it("preserves genuine informational buyer tasks with two matching article supports",async()=>{
  ask.mockResolvedValue(JSON.stringify({...supported,queryTask:"Understand writing tool costs",angle:"What small teams should budget for writing software",buyingJob:"Understand writing software costs"}));
  expect((await checkEditorialTask("writing software costs",organic,proposed)).status).toBe("supported");
});
