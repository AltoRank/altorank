// ---------------------------------------------------------------------------
// The decisions under test, each run on a stored case with production's code
// ---------------------------------------------------------------------------
//
// Nothing here restates a prompt or a parser. Each runner calls the function
// the product calls - `judgeBuyerFitFor`, `judgeOnResults`,
// `factCheckArticle` + `verifyCitedFigures` - with the case's evidence in
// place of a live provider, and turns the answer into a label to compare.

import { judgeBuyerFitFor, judgeOnResults, OPPORTUNITY_VERSION, type Opportunity, type OpportunityContext } from "@/lib/keyword-research/opportunity";
import type { AskModel } from "@/lib/keyword-research/buyer-model";
import type { FitVerdict } from "@/lib/keyword-research/buyer-fit";
import { factCheckArticle, type ClaimStatus } from "@/lib/ai/fact-check";
import { verifyCitedFigures, type PageFetcher } from "@/lib/seo/citation-check";
import type { ArticleResearch } from "@/lib/seo/research";
import type { ClaimCase, DecisionCase, Scored, TermCase } from "./types";

export function contextOf(c: DecisionCase): OpportunityContext {
  return { domain: c.domain, languageCode: c.languageCode, locationCode: c.locationCode, business: c.business };
}

// ── (b) Buyer fit ──────────────────────────────────────────────────────────

/** Every labelled term through the buyer test, batched exactly as qualification batches it. */
export async function runBuyerFit(c: DecisionCase, ask: AskModel): Promise<Scored[]> {
  const terms = c.terms.filter((t) => t.label.fit);
  if (!terms.length) return [];
  const fit = await judgeBuyerFitFor(contextOf(c), terms.map((t) => t.term), { ask });
  return terms.map((t) => {
    const v = fit.verdicts.get(t.term.trim().toLowerCase());
    const predicted = !v ? "no_decision" : v.keep ? "keep" : "reject";
    return {
      decision: "buyer-fit", caseId: c.id, item: t.term, expected: t.label.fit!, predicted,
      agrees: predicted === t.label.fit, reason: v?.reason ?? null, note: t.label.note ?? null, volume: t.volume ?? null,
    };
  });
}

// ── (a) Results-page qualification ─────────────────────────────────────────

/** The kept verdict the results judge is handed for a term, in isolation from the buyer test. */
export function keptVerdictFor(t: TermCase): Extract<FitVerdict, { keep: true }> {
  if (t.storedFit?.keep) return { keep: true, reason: t.storedFit.reason, funnel: t.storedFit.funnel ?? "buyer" };
  return { keep: true, reason: null, funnel: t.label.funnel ?? "buyer" };
}

/** What `judgeOnResults` came to, as a label: "qualified" or the cause. */
export function topicOutcome(o: Opportunity): string {
  return o.status === "qualified" ? "qualified" : o.cause ?? o.status;
}

/** A rejection for any reason is the right answer for a term that is not a buyer search. */
export function topicAgrees(expected: string, predicted: string): boolean {
  if (expected === "buyer_mismatch") return ["buyer_mismatch", "not_editorial", "needs_page", "existing_page"].includes(predicted);
  return expected === predicted;
}

/**
 * Every term with a results page and a label through the results judge.
 * Terms labelled `needs_serp`, or with no stored page, are skipped: there is
 * no evidence to judge them on.
 */
export async function runQualification(c: DecisionCase, ask: AskModel): Promise<Scored[]> {
  const context = contextOf(c);
  const out: Scored[] = [];
  for (const t of c.terms) {
    if (!t.label.verdict || t.label.verdict === "needs_serp" || !t.serp) continue;
    const result: Opportunity = { version: OPPORTUNITY_VERSION, context: "eval", checkedAt: `${c.today}T00:00:00.000Z`, status: "pending", reason: "" };
    await judgeOnResults(result, { term: t.term, sourceUrl: t.sourceUrl ?? null, context, verdict: keptVerdictFor(t), organic: t.serp.organic }, { ask, today: c.today });
    const predicted = topicOutcome(result);
    const scored: Scored = {
      decision: "qualification", caseId: c.id, item: t.term, expected: t.label.verdict, predicted,
      agrees: topicAgrees(t.label.verdict, predicted), reason: result.reason, note: t.label.note ?? null, volume: t.volume ?? null,
    };
    if (t.label.verdict === "qualified" && predicted === "qualified" && t.label.shape) scored.shape = { expected: t.label.shape, predicted: result.shape ?? null };
    out.push(scored);
  }
  return out;
}

/**
 * The two together, as the planner runs them: the buyer test first, the
 * results judge only for a kept term. Computed from the two runs above, so
 * it costs nothing more. Exact match: here buyer_mismatch means the buyer test.
 */
export function pipelineOf(fit: Scored[], qualification: Scored[], cases: DecisionCase[]): Scored[] {
  const byKey = (s: Scored) => `${s.caseId}\u0000${s.item}`;
  const fitOf = new Map(fit.map((s) => [byKey(s), s]));
  const qualOf = new Map(qualification.map((s) => [byKey(s), s]));
  const out: Scored[] = [];
  for (const c of cases) {
    for (const t of c.terms) {
      const expected = t.label.verdict;
      if (!expected || expected === "needs_serp") continue;
      const f = fitOf.get(`${c.id}\u0000${t.term}`);
      if (!f) continue;
      const q = qualOf.get(`${c.id}\u0000${t.term}`);
      let predicted: string;
      let reason: string | null | undefined;
      if (f.predicted === "reject") { predicted = "buyer_mismatch"; reason = f.reason; }
      else if (f.predicted === "no_decision") { predicted = "no_verdict"; reason = null; }
      else if (q) { predicted = q.predicted; reason = q.reason; }
      else continue; // Kept, but no results page to judge: nothing to say.
      out.push({ decision: "pipeline", caseId: c.id, item: t.term, expected, predicted, agrees: expected === predicted, reason, note: t.label.note ?? null, volume: t.volume ?? null });
    }
  }
  return out;
}

// ── (c) Fact check: does the cited page support the sentence? ──────────────

/** A claim's status after the citation check, as a label. */
export function claimOutcome(status: ClaimStatus | null): string {
  if (!status) return "not_extracted";
  if (status === "verified") return "supported";
  if (status === "contradicted" || status === "unsupported") return "unsupported";
  return "unverified";
}

/**
 * The article's claims through the extractor and the cited-page check, with
 * the stored copy of each cited page in place of a live GET. A page the case
 * has no copy of answers 404, which the check treats as unreadable.
 */
export async function runFactCheck(c: ClaimCase, readPage: (relative: string) => string | null): Promise<Scored[]> {
  const research = {
    competitors: [],
    trust: { sensitive: c.sensitive ? { kind: "health", evidence: "set by the eval case" } : null },
  } as unknown as ArticleResearch;
  const fetcher: PageFetcher = async (url) => {
    const relative = c.pages[url];
    const body = relative ? readPage(relative) : null;
    return body === null ? { status: 404, body: "" } : { status: 200, body };
  };
  const report = await verifyCitedFigures(factCheckArticle(c.html, research, c.language), { fetcher });
  return c.expect.map((e) => {
    const needle = e.match.toLowerCase();
    const claim = report.claims.find((x) => x.sentence.toLowerCase().includes(needle) || x.figures.some((f) => f.toLowerCase() === needle));
    const predicted = claimOutcome(claim?.status ?? null);
    return {
      decision: "fact-check", caseId: c.id, item: e.id, expected: e.label, predicted, agrees: predicted === e.label,
      reason: claim ? `${claim.status}: ${claim.note}` : "no claim extracted from this sentence", note: e.note ?? null,
    };
  });
}
