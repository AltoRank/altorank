import {expect,it} from "vitest";
import {firstDraftReadiness,DraftReadinessError,type ExpectedDraftDelivery} from "../draft-readiness";
import {CLAIM_COVERAGE_VERSION} from "../claim-verification";
import type {EditorialReview} from "../approved-output";
const expected:ExpectedDraftDelivery={task:"procedure",promises:[{id:"p0",source:"headline",quote:"Track work",text:"Track work",expectedAnswer:"A usable tracking procedure",mappingReason:"Central workflow",requirementIndices:[0]}]};
const report=():EditorialReview=>({status:"checked",headline:"preserved",productClaims:"no-issues-detected",qualitativeClaims:"no-issues-detected",structure:"no-issues-detected",findings:[],delivery:{version:1,status:"checked",promises:[{promiseId:"p0",answered:true,passageIndices:[1],reason:"The workflow is explained."}],procedure:{executable:true,passageIndices:[1],reason:"Reader can follow the workflow."}},claimVerification:{coverageVersion:CLAIM_COVERAGE_VERSION,sentenceInventory:[0,1].map(passageIndex=>({passageIndex,sentenceIndex:0,text:"Ask.",start:0,end:4})),sentenceCoverage:[0,1].map(passageIndex=>({passageIndex,sentenceIndex:0,claimIds:[],nonFactualReason:"Ordinary advice."})),status:"checked",totalPassages:2,checkedPassages:[0,1],claims:[],sources:[],failures:[],modelCalls:[]}});
it("allows complete checks with no known material findings, including minor edits",()=>{
 const r=report();expect(firstDraftReadiness(r,expected)).toBeNull();
 r.findings=[{category:"qualitative",severity:"editorial",removed:false,text:"Awkward sentence",reason:"Tighten wording"}];r.qualitativeClaims="needs-review";
 expect(firstDraftReadiness(r,expected)).toBeNull();
});
it("withholds partial, missing or falsely labelled complete coverage",()=>{
 const r=report();r.claimVerification!.checkedPassages=[0,0];expect(firstDraftReadiness(r,expected)).toBe("incomplete-review");
 r.claimVerification!.checkedPassages=[0,2];expect(firstDraftReadiness(r,expected)).toBe("incomplete-review");
 r.claimVerification!.checkedPassages=[0,1];r.claimVerification!.status="partial";expect(firstDraftReadiness(r,expected)).toBe("incomplete-review");
 delete r.claimVerification;expect(firstDraftReadiness(r,expected)).toBe("incomplete-review");
});
it("withholds material findings even when every passage was checked",()=>{
 const r=report();r.findings=[{category:"qualitative",severity:"material",removed:false,text:"Unsupported advice",reason:"Wrong audience"}];
 expect(firstDraftReadiness(r,expected)).toBe("material-findings");
 r.status="unavailable";expect(firstDraftReadiness(r,expected)).toBe("material-findings");
 expect(new DraftReadinessError("material-findings").retryable).toBe(false);
 expect(new DraftReadinessError("incomplete-review").retryable).toBe(true);
});
it("does not trust a clean editorial summary over a contradictory claim result",()=>{
 const r=report();r.claimVerification!.claims=[{passageIndex:0,category:"product",verdict:"contradicted",quote:"Free includes automation",reason:"Paid tier only",evidence:[],contradiction:""}];
 expect(firstDraftReadiness(r,expected)).toBe("material-findings");
});

it("does not accept old or falsified sentence coverage as a new ready draft",()=>{
 for(const change of [
   {coverageVersion:undefined}, {coverageVersion:0}, {sentenceInventory:undefined}, {sentenceCoverage:undefined},
   {sentenceCoverage:[]},
   {sentenceCoverage:[0,0].map(passageIndex=>({passageIndex,sentenceIndex:0,claimIds:[],nonFactualReason:"Advice."}))},
 ]){
   const r=report();Object.assign(r.claimVerification!,change);
   expect(firstDraftReadiness(r,expected)).toBe("incomplete-review");
 }
});

it("requires a versioned completed delivery receipt independently of the clean findings summary",()=>{
 for(const change of [undefined,{...report().delivery!,version:0},{...report().delivery!,status:"unavailable"},{...report().delivery!,promises:[]}]){
  const r=report();r.delivery=change as EditorialReview["delivery"];
  expect(firstDraftReadiness(r,expected)).toBe("incomplete-review");
 }
 for(const contract of [undefined,{task:"procedure",promises:undefined},{task:undefined,promises:expected.promises},{task:"procedure",promises:[]},{task:"procedure",promises:[...expected.promises!,...expected.promises!]}]){
  expect(firstDraftReadiness(report(),contract as ExpectedDraftDelivery)).toBe("incomplete-review");
 }
});

it("compares promise IDs with the expected frozen contract rather than trusting receipt counts",()=>{
 const r=report();r.delivery!.promises[0].promiseId="p9";
 expect(firstDraftReadiness(r,expected)).toBe("incomplete-review");
 r.delivery!.promises[0].promiseId="p0";r.delivery!.promises.push({...r.delivery!.promises[0]});
 const two={...expected,promises:[...expected.promises!,{...expected.promises![0],id:"p1"}]};
 expect(firstDraftReadiness(r,two)).toBe("incomplete-review");
 r.delivery!.promises[1].promiseId="p1";r.delivery!.promises.reverse();
 expect(firstDraftReadiness(r,two)).toBeNull();
});

it("retains undelivered promises and non-executable procedures as material even without findings",()=>{
 const missing=report();missing.delivery!.promises[0].answered=false;missing.delivery!.promises[0].passageIndices=[];
 expect(firstDraftReadiness(missing,expected)).toBe("material-findings");
 const incomplete=report();incomplete.delivery!.procedure!.executable=false;incomplete.delivery!.procedure!.passageIndices=[];
 expect(firstDraftReadiness(incomplete,expected)).toBe("material-findings");
});

it("refuses malformed claimed delivery and checks procedure presence against the expected task",()=>{
 for(const indices of [[],[-1],[0.5],[1,1]]){
  const r=report();r.delivery!.promises[0].passageIndices=indices;
  expect(firstDraftReadiness(r,expected)).toBe("incomplete-review");
  const p=report();p.delivery!.procedure!.passageIndices=indices;
  expect(firstDraftReadiness(p,expected)).toBe("incomplete-review");
 }
 const missing=report();delete missing.delivery!.procedure;
 expect(firstDraftReadiness(missing,expected)).toBe("incomplete-review");
 expect(firstDraftReadiness(report(),{...expected,task:"explanation"})).toBe("incomplete-review");
 expect(firstDraftReadiness(missing,{...expected,task:"explanation"})).toBeNull();
 const reason=report();reason.delivery!.promises[0].reason=" ";
 expect(firstDraftReadiness(reason,expected)).toBe("incomplete-review");
});

it("does not confuse editorial table-cell indices with the smaller claim-row inventory",()=>{
 const r=report();r.delivery!.promises[0].passageIndices=[2];r.delivery!.procedure!.passageIndices=[2];
 expect(r.claimVerification!.totalPassages).toBe(2);
 expect(firstDraftReadiness(r,expected)).toBeNull();
});
