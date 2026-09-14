import type {EditorialReview} from "./approved-output";
import {hasCompleteSentenceCoverage} from "./claim-verification";
import type {ArticlePromise} from "./evidence-scope";
import type {DraftEvidencePlan} from "./draft-evidence";

export interface ExpectedDraftDelivery { promises: ArticlePromise[] | undefined; task: DraftEvidencePlan["task"] | undefined }

/** The editorial receipt has its own passage indices (including table cells).
 * Its reviewer validates upper bounds against that inventory; claim-passage
 * counts cannot safely revalidate those bounds here. */
function deliveryReadiness(report: EditorialReview, expected: ExpectedDraftDelivery): DraftReadinessReason | null {
  const promises = expected?.promises;
  const delivery = report.delivery;
  if (!Array.isArray(promises) || !promises.length || promises.length > 12 ||
      promises.some(p => !p || typeof p.id !== "string" || !p.id.trim()) || new Set(promises.map(p => p.id)).size !== promises.length ||
      !["comparison", "procedure", "explanation"].includes(expected?.task ?? "") ||
      !delivery || delivery.version !== 1 || delivery.status !== "checked" || !Array.isArray(delivery.promises) || delivery.promises.length !== promises.length) return "incomplete-review";
  const validIndices = (indices: unknown): indices is number[] => Array.isArray(indices) && new Set(indices).size === indices.length && indices.every(i => Number.isInteger(i) && i >= 0);
  const reason = (value: unknown) => typeof value === "string" && Boolean(value.trim()) && value.length <= 300;
  if (new Set(delivery.promises.map(p => p?.promiseId)).size !== promises.length ||
      delivery.promises.some(p => !p || !promises.some(expected => expected.id === p.promiseId) || typeof p.answered !== "boolean" ||
        !validIndices(p.passageIndices) || (p.answered && !p.passageIndices.length) || !reason(p.reason))) return "incomplete-review";
  const procedure = delivery.procedure;
  if (expected.task === "procedure") {
    if (!procedure || typeof procedure.executable !== "boolean" || !validIndices(procedure.passageIndices) ||
        (procedure.executable && !procedure.passageIndices.length) || !reason(procedure.reason)) return "incomplete-review";
  } else if (procedure !== undefined) return "incomplete-review";
  if (delivery.promises.some(p => !p.answered) || procedure?.executable === false) return "material-findings";
  return null;
}

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
export function firstDraftReadiness(report: EditorialReview, expected: ExpectedDraftDelivery): DraftReadinessReason | null {
  const claims = report.claimVerification;
  if (report.findings.some(f => !f.removed && f.severity !== "editorial") ||
      claims?.claims.some(c => c.verdict === "unsupported" || c.verdict === "contradicted")) return "material-findings";
  const delivery = deliveryReadiness(report, expected);
  if (delivery) return delivery;
  if (report.status !== "checked" || !claims || claims.status !== "checked" || claims.failures.length || !hasCompleteSentenceCoverage(claims) ||
      !claims.totalPassages || new Set(claims.checkedPassages).size !== claims.totalPassages ||
      claims.checkedPassages.some(i => !Number.isInteger(i) || i < 0 || i >= claims.totalPassages) ||
      [report.productClaims,report.qualitativeClaims,report.structure].some(s => !s || s === "not-checked")) return "incomplete-review";
  // A category flag without its findings is not a trustworthy clean result.
  if ([report.productClaims,report.qualitativeClaims,report.structure].includes("needs-review") && !report.findings.some(f => !f.removed)) return "incomplete-review";
  return null;
}
