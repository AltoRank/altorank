import type {EditorialReview} from "./approved-output";

export type DraftReadinessReason = "evidence" | "incomplete-review" | "material-findings";
const messages: Record<DraftReadinessReason,string> = {
  evidence: "We need stronger sources to answer this topic well. Your ideas are saved. Try another topic or refine your buyer and offering.",
  "incomplete-review": "We couldn't finish the checks for this topic. Your ideas are saved and no draft allowance was used. Retry this topic or choose another.",
  "material-findings": "This draft needs corrections before it's ready to show you. Your ideas are saved and no draft allowance was used. Choose another topic or refine your buyer and offering.",
};
/** A rejected candidate is not a successful preview. It never advances the
 * calendar or free-draft counter. Transient checks may be retried by workers;
 * known evidence/quality failures require an explicit retry or changed topic. */
export class DraftReadinessError extends Error {
  constructor(public readonly reason: DraftReadinessReason, public readonly candidateHtml?: string) {
    super(messages[reason]);
    this.name = "DraftReadinessError";
  }
  get retryable() { return this.reason === "incomplete-review"; }
}

/** Complete model coverage and no known material defect are necessary, not a
 * guarantee of factual truth. Minor editorial suggestions stay reviewable. */
export function firstDraftReadiness(report: EditorialReview): DraftReadinessReason | null {
  const claims = report.claimVerification;
  if (report.findings.some(f => !f.removed && f.severity !== "editorial") ||
      claims?.claims.some(c => c.verdict === "unsupported" || c.verdict === "contradicted")) return "material-findings";
  if (report.status !== "checked" || !claims || claims.status !== "checked" || claims.failures.length ||
      !claims.totalPassages || new Set(claims.checkedPassages).size !== claims.totalPassages ||
      claims.checkedPassages.some(i => !Number.isInteger(i) || i < 0 || i >= claims.totalPassages) ||
      [report.productClaims,report.qualitativeClaims,report.structure].some(s => !s || s === "not-checked")) return "incomplete-review";
  // A category flag without its findings is not a trustworthy clean result.
  if ([report.productClaims,report.qualitativeClaims,report.structure].includes("needs-review") && !report.findings.some(f => !f.removed)) return "incomplete-review";
  return null;
}
