import {expect,it} from "vitest";
import {firstDraftReadiness,DraftReadinessError} from "../draft-readiness";
import type {EditorialReview} from "../approved-output";
const report=():EditorialReview=>({status:"checked",headline:"preserved",productClaims:"no-issues-detected",qualitativeClaims:"no-issues-detected",structure:"no-issues-detected",findings:[],claimVerification:{status:"checked",totalPassages:2,checkedPassages:[0,1],claims:[],sources:[],failures:[],modelCalls:[]}});
it("allows complete checks with no known material findings, including minor edits",()=>{
 const r=report();expect(firstDraftReadiness(r)).toBeNull();
 r.findings=[{category:"qualitative",severity:"editorial",removed:false,text:"Awkward sentence",reason:"Tighten wording"}];r.qualitativeClaims="needs-review";
 expect(firstDraftReadiness(r)).toBeNull();
});
it("withholds partial, missing or falsely labelled complete coverage",()=>{
 const r=report();r.claimVerification!.checkedPassages=[0,0];expect(firstDraftReadiness(r)).toBe("incomplete-review");
 r.claimVerification!.checkedPassages=[0,2];expect(firstDraftReadiness(r)).toBe("incomplete-review");
 r.claimVerification!.checkedPassages=[0,1];r.claimVerification!.status="partial";expect(firstDraftReadiness(r)).toBe("incomplete-review");
 delete r.claimVerification;expect(firstDraftReadiness(r)).toBe("incomplete-review");
});
it("withholds material findings even when every passage was checked",()=>{
 const r=report();r.findings=[{category:"qualitative",severity:"material",removed:false,text:"Unsupported advice",reason:"Wrong audience"}];
 expect(firstDraftReadiness(r)).toBe("material-findings");
 r.status="unavailable";expect(firstDraftReadiness(r)).toBe("material-findings");
 expect(new DraftReadinessError("material-findings").retryable).toBe(false);
 expect(new DraftReadinessError("incomplete-review").retryable).toBe(true);
});
it("does not trust a clean editorial summary over a contradictory claim result",()=>{
 const r=report();r.claimVerification!.claims=[{passageIndex:0,category:"product",verdict:"contradicted",quote:"Free includes automation",reason:"Paid tier only",evidence:[],contradiction:""}];
 expect(firstDraftReadiness(r)).toBe("material-findings");
});
