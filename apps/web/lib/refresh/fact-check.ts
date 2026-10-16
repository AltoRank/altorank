// ---------------------------------------------------------------------------
// The fact check of a proposed rewrite, as the email and the review page read it
// ---------------------------------------------------------------------------
//
// The rewrite runs the same fact check as a new draft and stores its report
// on the execution (`after.factCheckReport`). Executions written before that
// carry only the bare verdict (`after.factCheck`). Push runs the check again
// on what was kept (lib/refresh/push.ts); this is what the reviewer reads
// before deciding.

import type { FactCheckReport } from "@/lib/ai/fact-check";
import type { RewriteFactCheck } from "./types";

/**
 * What the fact check said about the proposed text, in the terms the email
 * and the review page need. `flagged` is the claims it asks a person to act
 * on: the ones to correct or remove when the verdict is `high_risk`, the
 * ones not yet verified against their source when it is `review`.
 */
export function rewriteFactCheck(report: FactCheckReport): RewriteFactCheck {
  const flagged =
    report.verdict === "high_risk"
      ? report.counts.high
      : report.verdict === "review"
        ? report.claims.filter((c) => c.status !== "verified").length
        : 0;
  return {
    verdict: report.verdict,
    flagged,
    ...(report.unchecked ? { unchecked: report.unchecked } : {}),
  };
}

const VERDICTS = new Set(["clean", "review", "high_risk", "unchecked"]);

/** The stored fact check of a rewrite: the full report when there is one, the bare verdict on older rows, or null. */
export function storedFactCheck(
  after: unknown,
): { report: FactCheckReport | null; verdict: FactCheckReport["verdict"] } | null {
  const side = (after ?? {}) as { factCheck?: unknown; factCheckReport?: unknown };
  const report = side.factCheckReport as FactCheckReport | undefined;
  if (report && typeof report === "object" && VERDICTS.has(report.verdict as string) && Array.isArray(report.claims)) {
    return { report, verdict: report.verdict };
  }
  if (typeof side.factCheck === "string" && VERDICTS.has(side.factCheck)) {
    return { report: null, verdict: side.factCheck as FactCheckReport["verdict"] };
  }
  return null;
}
