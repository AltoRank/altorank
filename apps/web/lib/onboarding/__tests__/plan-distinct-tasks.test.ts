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

it("does not reintroduce a synonym of an existing draft when filling the month",async()=>{
  const opportunity={status:"qualified",angle:"Choose an analytics tool",buyingJob:"Compare analytics tools",organicUrls:[]};
  recommend.mockResolvedValue([{keywordId:"synonym",term:"analytics tool comparison",action:"write",quality:"ok",opportunity}, {keywordId:"distinct",term:"track purchase revenue",action:"write",quality:"ok",opportunity:{...opportunity,buyingJob:"Configure revenue tracking"}}]);
  ask.mockResolvedValue('{"groups":[[0,1],[2]]}');
  const existing={keyword_id:"written",keyword:"traffic monitoring tools",scheduled_date:"2026-09-13",article_id:"preview",status:"scheduled"};
  const db={from(table:string){let reading=true;let ids:string[]=[];const q={select:()=>q,eq:()=>q,in:(_key:string,value:string[])=>{ids=value;return q;},not:()=>q,is:()=>q,delete:()=>q,update:()=>{reading=false;return q;},insert:()=>{reading=false;return q;},maybeSingle:()=>q,then:(resolve:(r:unknown)=>unknown)=>resolve({data:reading&&table==="calendar_entries"?[existing]:reading&&table==="keywords"&&ids.includes("written")?[{id:"written",term:existing.keyword,opportunity}]:[],error:null})};return q;}};
  const plan=await schedulePlan(db as never,"workspace-a",2,{mode:"fill-month",from:new Date("2026-09-13T00:00:00Z"),maxEntries:5,distinctTasks:true});
  expect(plan.map(p=>p.keywordId)).toEqual(["distinct"]);
  expect(plan.every(p=>p.date<"2026-10-13")).toBe(true);
});

it("honours the caller's remaining quota in top-up mode",async()=>{
  recommend.mockResolvedValue([0,1,2].map(i=>({keywordId:`k${i}`,term:`topic ${i}`,action:"write",quality:"ok"})));
  const db={from(){const q={select:()=>q,eq:()=>q,in:()=>q,not:()=>q,is:()=>q,delete:()=>q,update:()=>q,insert:()=>q,then:(resolve:(r:unknown)=>unknown)=>resolve({data:[],error:null})};return q;}};
  const plan=await schedulePlan(db as never,"workspace-a",14,{mode:"top-up",maxEntries:1});
  expect(plan).toHaveLength(1);
});
