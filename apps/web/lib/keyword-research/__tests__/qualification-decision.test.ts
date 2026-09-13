import { expect, it } from "vitest";
import { assessQualification } from "../qualification-decision";
const organic=[1,2,3].map((rank)=>({url:`https://source${rank}.test/guide`,title:"Compare booking software",description:"A buyer guide",rank,domain:`source${rank}.test`,wordCount:null}));
const assessment={results:organic.map((_r,resultIndex)=>({resultIndex,format:"article",evidenceField:"title"})),buyer:{relevant:true,reason:"Buyer selects software"},product:{supported:true,quote:"booking software",reason:"Actual offering"},editorial:{achievable:true,reason:"Comparison"},audience:"clinic owners",buyingJob:"choose software",offering:"booking software",angle:"How to compare booking software",conversionPath:"https://publisher.test/"};
it("attaches exact observed URLs and quotations to result classifications",()=>{
  const result=assessQualification(assessment,organic,"We offer booking software",[]);
  expect(result.status).toBe("qualified");
  expect(result.assessment?.results[0]).toMatchObject({url:organic[0].url,quote:organic[0].title});
});
it("rejects an absent result or an unavailable page extract",()=>{
  expect(assessQualification({...assessment,results:[{resultIndex:100,format:"article",evidenceField:"title"}]},organic,"booking software",[]).status).toBe("pending");
  expect(assessQualification({...assessment,results:organic.map((_r,resultIndex)=>({resultIndex,format:"article",evidenceField:"page"}))},organic,"booking software",[]).status).toBe("pending");
});
