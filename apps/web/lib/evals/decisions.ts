// ---------------------------------------------------------------------------
// The decisions under test, each run on a stored case with production's code
// ---------------------------------------------------------------------------
//
// Nothing here restates a prompt or a parser. Each runner calls the function
// the product calls - `judgeBuyerFitFor`, `judgeOnResults`,
// `factCheckArticle` + `verifyCitedFigures` - with the case's evidence in
// place of a live provider, and turns the answer into a label to compare.

import { askResultsJudge, existingPageIn, judgeBuyerFitFor, judgedResults, judgeOnResults, OPPORTUNITY_VERSION, readJudgeKinds, type Opportunity, type OpportunityContext } from "@/lib/keyword-research/opportunity";
import { extractJson, type AskModel } from "@/lib/keyword-research/buyer-model";
import { describePageKinds, namedIn, NEEDS_PAGE_MIN_PAGES, readResultsPage, type PageType, type ResultsPageReading } from "@/lib/keyword-research/results-page";
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

// ── (d) Page type: what the results pages are, decided in code ─────────────

/** The labels that say what a results page wants; `buyer_mismatch` is about the searcher, not the page. */
export const PAGE_TYPE_LABELS: ReadonlySet<string> = new Set(["qualified", "needs_page", "not_editorial", "existing_page"]);

/** A page type as the verdict it leads to. */
export function pageTypeOutcome(reading: Pick<ResultsPageReading, "type">): string {
  const by: Record<PageType, string> = { editorial: "qualified", mixed: "qualified", service: "needs_page", local: "needs_page", other: "not_editorial", navigational: "buyer_mismatch" };
  return by[reading.type];
}

/**
 * Every term whose label is about its results page, through the page-type
 * rule (lib/keyword-research/results-page.ts) on the stored page: free and
 * deterministic. The judge's word for each result is the stored answer to
 * the exact question qualification asks, replayed through `ask` (never
 * bought: the harness hands this a replay-only recorder); where no answer is
 * stored, the URL-and-title word lists read the results, as production does
 * when the judge names none. `baseline` is the same page read the way it was
 * before the rule: the judge's or the lists' word final, no thresholds.
 *
 * Mirrors qualification's order: an own page, then too few results, then a
 * phrase naming a rival, decide before any results are read.
 */
export async function runPageType(c: DecisionCase, ask: AskModel): Promise<Scored[]> {
  const context = contextOf(c);
  const named = [...(c.business?.competitors ?? []), ...(c.business?.searchRivals ?? [])].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  const out: Scored[] = [];
  for (const t of c.terms) {
    if (!t.label.verdict || !PAGE_TYPE_LABELS.has(t.label.verdict) || !t.serp) continue;
    const organic = judgedResults(t.serp.organic);
    const base = { decision: "page-type" as const, caseId: c.id, item: t.term, expected: t.label.verdict, note: t.label.note ?? null, volume: t.volume ?? null, ...(t.label.published ? { published: true } : {}) };
    const fixed = (predicted: string, reason: string): Scored => ({ ...base, predicted, baseline: predicted, agrees: predicted === t.label.verdict, reason });
    const existing = existingPageIn(organic, t.sourceUrl, c.domain);
    if (existing) { out.push(fixed("existing_page", `An own page targets it: ${existing}`)); continue; }
    if (organic.length < 3) { out.push(fixed("thin_serp", `Only ${organic.length} results.`)); continue; }
    const nameHit = namedIn(t.term, named);
    if (nameHit) { out.push(fixed("buyer_mismatch", `The phrase names ${nameHit}.`)); continue; }
    const raw = await askResultsJudge({ term: t.term, context, verdict: keptVerdictFor(t), organic }, { ask, today: c.today });
    const parsed = extractJson<Record<string, unknown>>(raw, "{", "}");
    const judged = parsed ? readJudgeKinds(parsed.kinds, organic.length) : null;
    const options = { term: t.term, named, domain: c.domain, ...(judged ? { judged } : {}) };
    const after = readResultsPage(organic, options);
    const before = readResultsPage(organic, { ...options, pageRule: false });
    const predicted = pageTypeOutcome(after);
    out.push({
      ...base, predicted, agrees: predicted === t.label.verdict, baseline: pageTypeOutcome(before), basis: judged ? "judge" : "urls",
      built: { after: builtPages(after), before: builtPages(before) },
      reason: `${after.type}${after.rule ? ` (rule: ${after.rule})` : ""}: ${describePageKinds(after.pages)}; ${after.decidedByCode} read from the page itself. Before the rule: ${before.type}.`,
    });
  }
  return out;
}

/** The pages the needs-page threshold counts: providers' own pages, listings and shop pages. */
const builtPages = (reading: Pick<ResultsPageReading, "pages">) => reading.pages.service_or_local + reading.pages.directory + reading.pages.product;

/** The page-type proof's numbers (spec S4): needs_page recall, qualified topics lost, published topics kept - after the rule and before it. */
export interface PageTypeSummary {
  n: number;
  byJudge: number;
  /**
   * Qualified labels one page short of `NEEDS_PAGE_MIN_PAGES` with more
   * built pages than the judge's reading alone gave: the page's own reading
   * brought them to the edge, and one more misread page refuses them. A
   * margin check, not an error.
   */
  qualifiedAtEdge: { threshold: number; terms: string[] };
  needsPage: { labelled: number; after: number; before: number };
  qualifiedLost: { labelled: number; after: number; before: number; terms: string[] };
  published: { labelled: number; keptAfter: number; keptBefore: number };
  agreement: { after: number; before: number };
}

export function pageTypeSummary(items: readonly Scored[]): PageTypeSummary {
  const list = items.filter((s) => s.decision === "page-type");
  const needs = list.filter((s) => s.expected === "needs_page");
  const qualified = list.filter((s) => s.expected === "qualified");
  const published = list.filter((s) => s.published);
  const lostAfter = qualified.filter((s) => s.predicted === "needs_page" || s.predicted === "not_editorial");
  return {
    n: list.length,
    byJudge: list.filter((s) => s.basis === "judge").length,
    qualifiedAtEdge: {
      threshold: NEEDS_PAGE_MIN_PAGES,
      terms: qualified.filter((s) => s.built && s.built.after >= NEEDS_PAGE_MIN_PAGES - 1 && s.built.after > s.built.before && s.predicted === "qualified").map((s) => `${s.caseId}: ${s.item}`),
    },
    needsPage: { labelled: needs.length, after: needs.filter((s) => s.predicted === "needs_page").length, before: needs.filter((s) => s.baseline === "needs_page").length },
    qualifiedLost: {
      labelled: qualified.length, after: lostAfter.length,
      before: qualified.filter((s) => s.baseline === "needs_page" || s.baseline === "not_editorial").length,
      terms: lostAfter.map((s) => `${s.caseId}: ${s.item}`),
    },
    published: { labelled: published.length, keptAfter: published.filter((s) => s.predicted === "qualified").length, keptBefore: published.filter((s) => s.baseline === "qualified").length },
    agreement: { after: list.filter((s) => s.agrees).length, before: list.filter((s) => s.baseline === s.expected).length },
  };
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
