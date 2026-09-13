import { reviewApprovedOutput, type EditorialReview, type ReviewOptions } from "./approved-output";
import { verifyDraftClaims, type ClaimVerification } from "./claim-verification";
import { withCapabilityEvidence } from "./draft-evidence";
import type { PageExtract } from "@/lib/keyword-research/page-evidence";

/** Add source-backed claim findings without treating an incomplete check as clean. */
export function attachClaimVerification(report: EditorialReview, claims: ClaimVerification): EditorialReview {
  const findings = [...report.findings];
  for (const claim of claims.claims.filter(c => c.verdict !== "supported")) {
    if (!findings.some(f=>f.text===claim.quote && f.reason===claim.reason)) findings.push({category:claim.category,severity:"material",text:claim.quote,reason:claim.reason,removed:false});
  }
  const state = <T extends EditorialReview["productClaims"]>(category:"product"|"qualitative", current:T) => findings.some(f=>f.category===category&&!f.removed) ? "needs-review" as const : claims.status!=="checked" ? "not-checked" as const : current;
  return {...report,claimVerification:claims,findings,
    status:report.status==="checked"&&claims.status==="checked"?"checked":"unavailable",
    ...(claims.status!=="checked"?{unavailableReason:"Some source checks could not finish. Review the flagged claims and their sources before publishing."}:{}),
    productClaims:state("product",report.productClaims),
    qualitativeClaims:state("qualitative",report.qualitativeClaims),
    modelCalls:[...(report.modelCalls??[]),...claims.modelCalls],
  };
}

export async function reviewFirstDraft(html: string, options: ReviewOptions & {evidence:PageExtract[]}) {
  const evidence = withCapabilityEvidence(options.evidence, options.profile);
  const [editorial,claims]=await Promise.all([
    reviewApprovedOutput(html,{...options,evidence}),
    verifyDraftClaims(html,{evidence,brief:options.brief,spend:options.spend}),
  ]);
  return {...editorial,report:attachClaimVerification(editorial.report,claims)};
}
