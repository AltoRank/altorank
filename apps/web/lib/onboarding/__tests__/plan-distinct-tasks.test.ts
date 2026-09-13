import {expect,it,vi} from "vitest";
const {recommend,ask}=vi.hoisted(()=>({recommend:vi.fn(),ask:vi.fn()}));
vi.mock("@/lib/seo/recommendations",()=>({recommendKeywords:recommend}));
vi.mock("@/lib/e2e/stubs",()=>({e2eStubsEnabled:()=>false}));
vi.mock("@/lib/keyword-research/buyer-model",async original=>({...await original<object>(),askStructured:ask}));
import {schedulePlan} from "../plan";
it("writes only the distinct first-choice topics into the scoped calendar",async()=>{
  recommend.mockResolvedValue([0,1,2].map(i=>({keywordId:`k${i}`,term:`topic ${i}`,action:"write",quality:"ok",opportunity:{status:"qualified",angle:`Headline ${i}`,buyingJob:"Compare the tools",organicUrls:[]}})));
  ask.mockResolvedValue('{"groups":[[0,1],[2]]}');
  const writes:Array<{table:string;rows:Array<{workspace_id:string;keyword_id:string}>}>=[];
  const db={from(table:string){const q={select:()=>q,eq:()=>q,in:()=>q,not:()=>q,is:()=>q,delete:()=>q,update:()=>q,insert:(rows:Array<{workspace_id:string;keyword_id:string}>)=>{writes.push({table,rows});return q;},then:(resolve:(r:unknown)=>unknown)=>resolve({data:[],error:null})};return q;}};
  const plan=await schedulePlan(db as never,"workspace-a",2,{maxEntries:5,distinctTasks:true});
  expect(plan.map(p=>p.keywordId)).toEqual(["k0","k2"]);
  expect(writes).toEqual([{table:"calendar_entries",rows:expect.arrayContaining([expect.objectContaining({workspace_id:"workspace-a",keyword_id:"k0"}),expect.objectContaining({workspace_id:"workspace-a",keyword_id:"k2"})])}]);
  expect(writes[0].rows).toHaveLength(2);
});
