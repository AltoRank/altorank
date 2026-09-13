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
