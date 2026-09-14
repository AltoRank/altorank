import { enforceApprovedTitle, reviewApprovedOutput, type EditorialReview, type ReviewOptions } from "./approved-output";
import { verifyDraftClaims, hasCompleteSentenceCoverage, type ClaimVerification } from "./claim-verification";
import { withCapabilityEvidence } from "./draft-evidence";
import type { PageExtract } from "@/lib/keyword-research/page-evidence";

/** Add source-backed claim findings without treating an incomplete check as clean. */
export function attachClaimVerification(report: EditorialReview, claims: ClaimVerification): EditorialReview {
  const findings = [...report.findings];
  const complete = claims.status === "checked" && hasCompleteSentenceCoverage(claims);
  for (const claim of claims.claims.filter(c => c.verdict === "unsupported" || c.verdict === "contradicted")) {
    if (!findings.some(f=>f.text===claim.quote && f.reason===claim.reason)) findings.push({category:claim.category,severity:"material",text:claim.quote,reason:claim.reason,removed:false});
  }
  const state = <T extends EditorialReview["productClaims"]>(category:"product"|"qualitative", current:T) => findings.some(f=>f.category===category&&!f.removed) ? "needs-review" as const : !complete ? "not-checked" as const : current;
  return {...report,claimVerification:claims,findings,
    status:report.status==="checked"&&complete?"checked":"unavailable",
    ...(!complete?{unavailableReason:"Some source checks could not finish. Review the flagged claims and their sources before publishing."}:{}),
    productClaims:state("product",report.productClaims),
    qualitativeClaims:state("qualitative",report.qualitativeClaims),
    modelCalls:[...(report.modelCalls??[]),...claims.modelCalls],
  };
}

export async function reviewFirstDraft(html: string, options: ReviewOptions & {evidence:PageExtract[]}) {
  // Both audits must describe the exact returned draft. Normalize the headline
  // once, then retain even flagged duplicate paragraphs until an explicit edit
  // can receive a fresh review. Other editorial callers keep legacy cleanup.
  html = enforceApprovedTitle(html, options.title);
  const evidence = withCapabilityEvidence(options.evidence, options.profile);
  const [editorial,claims]=await Promise.all([
    reviewApprovedOutput(html,{...options,evidence,preserveReviewedHtml:true}),
    verifyDraftClaims(html,{evidence,brief:options.brief,spend:options.spend}),
  ]);
  return {...editorial,report:attachClaimVerification(editorial.report,claims)};
}
