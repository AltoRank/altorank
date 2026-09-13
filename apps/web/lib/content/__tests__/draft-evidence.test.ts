import {beforeEach,it,expect,vi} from "vitest";
const {read,ask}=vi.hoisted(()=>({read:vi.fn(),ask:vi.fn()}));
vi.mock("@/lib/keyword-research/page-evidence",()=>({readPageExtract:read}));
vi.mock("@/lib/keyword-research/buyer-model",()=>({askStructured:ask,extractJson:(raw:string)=>{try{return JSON.parse(raw);}catch{return null;}}}));
import {collectTaskEvidence} from "../draft-evidence";
beforeEach(()=>{vi.resetAllMocks();});
it("follows only selected observed source URLs and records missing retrieval",async()=>{
  read.mockImplementation(async(url:string)=>url==="https://review.test/list"?{url,title:"Review",headings:[],text:"A detailed comparison",links:[{url:"https://vendor.test/docs",label:"Product documentation"}]}:null);
  ask.mockResolvedValue(JSON.stringify({task:"comparison",requirements:["Which exports are supported?"],linkIndices:[0]}));
  const result=await collectTaskEvidence(null,undefined,["https://review.test/list"],{});
  expect(result.plan.selectedUrls).toEqual(["https://vendor.test/docs"]);
  expect(result.plan.retrievedUrls).toEqual([]);
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0].links).toBeUndefined();
});
it("refuses fabricated evidence indices without fetching a guessed destination",async()=>{
  read.mockResolvedValue({url:"https://review.test/list",title:"Review",headings:[],text:"A detailed comparison",links:[]});
  ask.mockResolvedValue(JSON.stringify({task:"comparison",requirements:[],linkIndices:[17]}));
  const result=await collectTaskEvidence(null,undefined,["https://review.test/list"],{});
  expect(result.plan.status).toBe("unavailable");
  expect(read).toHaveBeenCalledTimes(1);
});

import {withCapabilityEvidence,retrievedCitationPages} from "../draft-evidence";
import {unwrapUnknownInternalLinks} from "@/lib/seo/link-resolver";
import type {BusinessFocus} from "@/lib/onboarding/profile-focus";
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
  const links=Array.from({length:6},(_,i)=>({url:`https://vendor${i}.test/pricing`,label:`Vendor ${i} pricing`}));
  read.mockImplementation(async(url:string)=>({url,title:"Pricing",text:"An observed source with product plans and prices.",headings:[],links:url==="https://review.test/list"?links:[]}));
  ask.mockResolvedValue(JSON.stringify({task:"comparison",requirements:["What does each team cost?"],linkIndices:[0,1,2,3,4,5]}));
  const result=await collectTaskEvidence(null,undefined,["https://review.test/list"],{});
  expect(result.plan.retrievedUrls).toHaveLength(6);expect(read).toHaveBeenCalledTimes(7);
  ask.mockResolvedValue(JSON.stringify({task:"comparison",requirements:[],linkIndices:[0,1,2,3,4,5,0]}));
  expect((await collectTaskEvidence(null,undefined,["https://review.test/list"],{})).plan.status).toBe("unavailable");
});
