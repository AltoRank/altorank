import { expect, it } from "vitest";
import { assessQualification } from "../qualification-decision";
const organic=[1,2,3].map((rank)=>({url:`https://source${rank}.test/guide`,title:"Compare booking software",description:"A buyer guide",rank,domain:`source${rank}.test`,wordCount:null}));
const relevance={buyer:true,task:true,reason:"Clinic owners compare software options"};
const assessment={results:organic.map((_r,resultIndex)=>({resultIndex,format:"article",evidenceField:"title",relevance})),buyer:{relevant:true,reason:"Buyer selects software"},product:{supported:true,quote:"booking software",reason:"Actual offering"},editorial:{achievable:true,reason:"Comparison"},audience:"clinic owners",buyingJob:"choose software",offering:"booking software",angle:"How to compare booking software",conversionPath:"https://publisher.test/"};
it("attaches exact observed URLs and quotations to result classifications",()=>{
  const result=assessQualification(assessment,organic,"We offer booking software",[]);
  expect(result.status).toBe("qualified");
  expect(result.assessment?.results[0]).toMatchObject({url:organic[0].url,quote:organic[0].title});
});
it("does not qualify a consumer booking task from developer articles and a product page",()=>{
  const results=[
    {resultIndex:0,format:"article",evidenceField:"title",relevance:{buyer:false,task:false,reason:"Developers building a booking app"}},
    {resultIndex:1,format:"article",evidenceField:"title",relevance:{buyer:false,task:false,reason:"Agencies estimating app development costs"}},
    {resultIndex:2,format:"product",evidenceField:"title",relevance:{buyer:true,task:true,reason:"Consumers can download an app"}},
  ];
  const observed=organic.map((row,index)=>({...row,title:["How to build a beauty appointment app","Beauty app development costs","Fresha for customers"][index]}));
  expect(assessQualification({...assessment,results,audience:"Consumers booking beauty treatments",buyingJob:"Find and book a nearby treatment",angle:"How to find and book beauty treatments with an app"},observed,"booking software",[])).toMatchObject({status:"rejected",evidenceUrls:[]});
});
it("retains relevant comparisons in a mixed SERP without requiring publisher mentions",()=>{
  const observed=organic.map((row,index)=>({...row,title:["Compare appointment platforms for small clinics","How clinic owners should assess booking software","How to develop a booking app"][index]}));
  const results=assessment.results.map((row,index)=>({...row,relevance:index===2?{buyer:false,task:false,reason:"Developers building the application"}:relevance}));
  expect(assessQualification({...assessment,results},observed,"booking software",[])).toMatchObject({status:"qualified",evidenceUrls:organic.slice(0,2).map(row=>row.url)});
});
it.each([undefined,null,{},true,{buyer:true,task:true},{buyer:"true",task:true,reason:"Same buyer"},{buyer:true,task:true,reason:" "}])("leaves missing or malformed per-result relevance pending: %j",(invalid)=>{
  const results=assessment.results.map((row,index)=>index===0?{...row,relevance:invalid}:row);
  expect(assessQualification({...assessment,results},organic,"booking software",[]).status).toBe("pending");
});
it("keeps buyer relevance separate from task relevance",()=>{
  const results=assessment.results.map(row=>({...row,relevance:{buyer:true,task:false,reason:"Same buyer but an unrelated payroll task"}}));
  expect(assessQualification({...assessment,results},organic,"booking software",[])).toMatchObject({status:"rejected",evidenceUrls:[]});
});
it("rejects an absent result or an unavailable page extract",()=>{
  expect(assessQualification({...assessment,results:[{resultIndex:100,format:"article",evidenceField:"title"}]},organic,"booking software",[]).status).toBe("pending");
  expect(assessQualification({...assessment,results:organic.map((_r,resultIndex)=>({resultIndex,format:"article",evidenceField:"page"}))},organic,"booking software",[]).status).toBe("pending");
});
