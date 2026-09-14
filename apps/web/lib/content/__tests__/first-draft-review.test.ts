import {expect,it} from "vitest";
import {attachClaimVerification} from "../first-draft-review";
import type {EditorialReview} from "../approved-output";
import {CLAIM_COVERAGE_VERSION, type ClaimVerification} from "../claim-verification";
const review:EditorialReview={status:"checked",headline:"preserved",productClaims:"no-issues-detected",qualitativeClaims:"no-issues-detected",structure:"no-issues-detected",findings:[]};
const verification:ClaimVerification={coverageVersion:CLAIM_COVERAGE_VERSION,sentenceInventory:[{passageIndex:0,sentenceIndex:0,text:"All plans include three sites.",start:0,end:30}],sentenceCoverage:[{passageIndex:0,sentenceIndex:0,claimIds:["limit"],nonFactualReason:""}],status:"checked",totalPassages:1,checkedPassages:[0],sources:[],failures:[],modelCalls:[],claims:[{claimId:"limit",sentenceIndex:0,passageIndex:0,quote:"All plans include three sites.",category:"product",verdict:"unsupported",reason:"This limit belongs to Managed only.",evidence:[],contradiction:""}]};
it("a whole-article clean review cannot hide a specific unsupported claim",()=>{
  const result=attachClaimVerification(review,verification);
  expect(result.productClaims).toBe("needs-review");expect(result.findings[0].text).toBe(verification.claims[0].quote);
  expect(result.claimVerification).toBe(verification);
});
it("partial checks retain genuine findings and do not present unchecked categories as clean",()=>{
  const result=attachClaimVerification(review,{...verification,status:"partial",checkedPassages:[]});
  expect(result.status).toBe("unavailable");expect(result.productClaims).toBe("needs-review");expect(result.qualitativeClaims).toBe("not-checked");expect(result.findings).toHaveLength(1);
});
it("successful source checks cannot conceal an unavailable structure review",()=>{
  expect(attachClaimVerification({...review,status:"unavailable",structure:"not-checked"},verification).status).toBe("unavailable");
});
it("does not turn a nonfactual scope decision into a material warning or source approval",()=>{
  const classified:ClaimVerification={...verification,sentenceInventory:[{passageIndex:0,sentenceIndex:0,text:"This guide compares three options.",start:0,end:34}],claims:[{...verification.claims[0],category:"qualitative",verdict:"not-factual",quote:"This guide compares three options.",reason:"Article roadmap, not an external factual assertion."}]};
  const result=attachClaimVerification(review,classified);
  expect(result.findings).toEqual([]);
  expect(result.claimVerification?.claims[0].verdict).toBe("not-factual");
  const separate={category:"qualitative" as const,severity:"material" as const,text:"Other factual assertion",reason:"Independent editorial issue",removed:false};
  expect(attachClaimVerification({...review,findings:[separate]},classified).findings).toEqual([separate]);
});

it("does not attach a legacy checked report as complete without its sentence inventory",()=>{
 const legacy={...verification,coverageVersion:undefined,sentenceInventory:undefined,sentenceCoverage:undefined,claims:[]};
 const result=attachClaimVerification(review,legacy);
 expect(result.status).toBe("unavailable");expect(result.productClaims).toBe("not-checked");
});
