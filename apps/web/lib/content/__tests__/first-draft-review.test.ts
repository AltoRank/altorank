import {expect,it} from "vitest";
import {attachClaimVerification} from "../first-draft-review";
import type {EditorialReview} from "../approved-output";
import type {ClaimVerification} from "../claim-verification";
const review:EditorialReview={status:"checked",headline:"preserved",productClaims:"no-issues-detected",qualitativeClaims:"no-issues-detected",structure:"no-issues-detected",findings:[]};
const verification:ClaimVerification={status:"checked",totalPassages:1,checkedPassages:[0],sources:[],failures:[],modelCalls:[],claims:[{passageIndex:0,quote:"All plans include three sites.",category:"product",verdict:"unsupported",reason:"This limit belongs to Managed only.",evidence:[],contradiction:""}]};
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
