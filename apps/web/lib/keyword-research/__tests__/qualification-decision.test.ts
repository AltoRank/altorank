import { expect, it } from "vitest";
import { assessQualification, productEvidenceRecords } from "../qualification-decision";
const evidence=productEvidenceRecords({priorityOffering:"booking software"});
const organic=[1,2,3].map((rank)=>({url:`https://source${rank}.test/guide`,title:"Compare booking software",description:"A buyer guide",rank,domain:`source${rank}.test`,wordCount:null}));
const relevance={buyer:true,task:true,reason:"Clinic owners compare software options"};
const assessment={results:organic.map((_r,resultIndex)=>({resultIndex,format:"article",evidenceField:"title",relevance})),buyer:{relevant:true,reason:"Buyer selects software"},product:{supported:true,evidenceId:"priority-offering",reason:"Actual offering"},editorial:{achievable:true,reason:"Comparison"},audience:"clinic owners",buyingJob:"choose software",offering:"booking software",angle:"How to compare booking software",conversionPath:"https://publisher.test/"};
it("attaches exact observed URLs and quotations to result classifications",()=>{
  const result=assessQualification(assessment,organic,evidence,[]);
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
  expect(assessQualification({...assessment,results,audience:"Consumers booking beauty treatments",buyingJob:"Find and book a nearby treatment",angle:"How to find and book beauty treatments with an app"},observed,evidence,[])).toMatchObject({status:"rejected",evidenceUrls:[]});
});
it("retains relevant comparisons in a mixed SERP without requiring publisher mentions",()=>{
  const observed=organic.map((row,index)=>({...row,title:["Compare appointment platforms for small clinics","How clinic owners should assess booking software","How to develop a booking app"][index]}));
  const results=assessment.results.map((row,index)=>({...row,relevance:index===2?{buyer:false,task:false,reason:"Developers building the application"}:relevance}));
  expect(assessQualification({...assessment,results},observed,evidence,[])).toMatchObject({status:"qualified",evidenceUrls:organic.slice(0,2).map(row=>row.url)});
});
it.each([undefined,null,{},true,{buyer:true,task:true},{buyer:"true",task:true,reason:"Same buyer"},{buyer:true,task:true,reason:" "}])("leaves missing or malformed per-result relevance pending: %j",(invalid)=>{
  const results=assessment.results.map((row,index)=>index===0?{...row,relevance:invalid}:row);
  expect(assessQualification({...assessment,results},organic,evidence,[]).status).toBe("pending");
});
it("keeps buyer relevance separate from task relevance",()=>{
  const results=assessment.results.map(row=>({...row,relevance:{buyer:true,task:false,reason:"Same buyer but an unrelated payroll task"}}));
  expect(assessQualification({...assessment,results},organic,evidence,[])).toMatchObject({status:"rejected",evidenceUrls:[]});
});
it("rejects an absent result or an unavailable page extract",()=>{
  expect(assessQualification({...assessment,results:[{resultIndex:100,format:"article",evidenceField:"title"}]},organic,evidence,[]).status).toBe("pending");
  expect(assessQualification({...assessment,results:organic.map((_r,resultIndex)=>({resultIndex,format:"article",evidenceField:"page"}))},organic,evidence,[]).status).toBe("pending");
});

it("attaches exact capability evidence despite response capitalization or concatenation",()=>{
  const quote="Underfoot, our dual-density Featherbed™ insole uses plush memory foam for comfort that lasts all day.";
  const records=productEvidenceRecords({priorityOffering:"Comfortable everyday footwear",capabilities:[{claim:"All-day comfort",quote,sourceUrl:"https://allbirds.com/products/shoe",status:"observed"}]});
  for(const transcribed of ["Dual-density Featherbed™ insole uses plush memory foam",`${quote} Machine washable too.`]) {
    const result=assessQualification({...assessment,product:{supported:true,evidenceId:"capability:0",quote:transcribed,reason:"Footwear sold for daily comfort"}},organic,records,[]);
    expect(result.status).toBe("qualified");
    expect(result.assessment?.product).toMatchObject({quote,evidence:{id:"capability:0",kind:"capability",sourceUrl:"https://allbirds.com/products/shoe"}});
  }
});
it("does not accept missing or fabricated IDs even with plausible exact copied text",()=>{
  for(const evidenceId of [undefined,null,"capability:99","https://external.test/guide"]) {
    const result=assessQualification({...assessment,product:{supported:true,evidenceId,quote:"booking software",reason:"Looks related"}},organic,evidence,[]);
    expect(result.status).toBe("pending");
    expect(result.assessment?.product.quote).toBe("");
  }
});
it("exposes confirmed category separately from capabilities and excludes inferred claims",()=>{
  const records=productEvidenceRecords({priorityOffering:"Everyday footwear",capabilities:[{claim:"Orthopedic treatment",quote:"Treat foot conditions",sourceUrl:"https://publisher.test/product",status:"inferred"}]});
  expect(records).toEqual([{id:"priority-offering",kind:"confirmed-category",quote:"Everyday footwear",claim:"Everyday footwear"}]);
  expect(productEvidenceRecords({capabilities:[]})).toEqual([]);
  expect(assessQualification({...assessment,product:{supported:false,evidenceId:"priority-offering",reason:"Ordinary footwear category does not establish a medical treatment feature"}},organic,records,[])).toMatchObject({status:"rejected"});
});
it("keeps two relevant articles when peripheral shopping or unknown results cannot change eligibility",()=>{
  const observed=organic.map((row,index)=>({...row,title:index===2?"Best Shoes for Standing All Day":row.title}));
  for(const format of ["product","tool","navigation","unknown"]) {
    const results=assessment.results.map((row,index)=>index===2?{...row,format}:row);
    expect(assessQualification({...assessment,results},observed,evidence,[])).toMatchObject({status:"qualified",evidenceUrls:organic.slice(0,2).map(row=>row.url),contradictions:[]});
  }
});
it("holds a necessary second article until its uncertain format is reviewed",()=>{
  const results=assessment.results.map((row,index)=>({...row,format:index===0?"article":index===1?"unknown":"product",relevance:index===2?{buyer:false,task:false,reason:"Unrelated shopping page"}:relevance}));
  expect(assessQualification({...assessment,results},organic,evidence,[])).toMatchObject({status:"pending",evidenceUrls:[organic[0].url],contradictions:[expect.stringContaining(organic[1].url)]});
  const supported=results.map((row,index)=>index===1?{...row,format:"article"}:row);
  expect(assessQualification({...assessment,results:supported},organic,evidence,[]).status).toBe("qualified");
});
it("does not spend format review on rows that cannot supply a buyer-relevant article pair",()=>{
  const observed=organic.map(row=>({...row,title:"Best tools for developers"}));
  const results=assessment.results.map((row,index)=>({...row,format:index===0?"article":"tool",relevance:index===0?relevance:{buyer:false,task:false,reason:"Developers building the product"}}));
  expect(assessQualification({...assessment,results},observed,evidence,[])).toMatchObject({status:"rejected",evidenceUrls:[organic[0].url],contradictions:[]});
});
it("does not bypass a missing own ranking-page check when two articles already support the task",()=>{
  expect(assessQualification(assessment,organic,evidence,[],"https://publisher.test/existing")).toMatchObject({status:"pending",reason:expect.stringContaining("ranking page")});
});
