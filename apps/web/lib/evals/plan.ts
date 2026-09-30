// ---------------------------------------------------------------------------
// The plan, scored: what the planner makes of the reader's verdicts
// ---------------------------------------------------------------------------
//
// The rest of the harness stops at the reader: was each term's verdict right?
// A customer never sees a verdict. They see five planned topics and one first
// article, and on 2026-09-30 the live check graded 13 of 22 labelled planned
// slots right and put 3 of 7 first articles on the wrong topic while most
// verdicts agreed with their labels: the ordering, not the reading, chose a
// high-volume general-interest topic as the first article.
//
// So this replays the planner's selection over the verdicts the reader gave
// (recorded, so a replay is free) and scores the plan it makes:
//
//   planned-slot precision   of the planned slots a person labelled, the
//                            share labelled qualified (value 0 is wrong)
//   first article            correct when its label is an editorial
//                            topic (not needs_page, not_editorial,
//                            buyer_mismatch or existing_page) of value >= 2
//   top of funnel            planned slots the product labels top of funnel,
//                            and the ones a person graded value 1
//   brand terms planned      a search for one business (lib/keyword-research/
//                            results-page.ts `namedIn`)
//   page type in the plan    planned slots whose verdict is not an editorial
//                            approval (the product side), or labelled
//                            needs_page / not_editorial (the label side)
//
// and the invariants a pull request must keep on the public sample (see
// `planInvariants`). A selector is a function, so the plan the product makes
// and the plan the #263 rule made are scored on the same verdicts.
//
// Pure: no database, no model. The verdicts come from ./decisions.ts.

import type { Opportunity } from "@/lib/keyword-research/opportunity";
import { namedIn } from "@/lib/keyword-research/results-page";
import { clusterByIntent, intentLanguage } from "@/lib/keyword-research/intent";
import { volumeScore, winnability } from "@/lib/seo/difficulty";
import type { DecisionCase, TermCase, TopicLabel } from "./types";

/** The first look's plan size (lib/onboarding/pipeline.ts `maxEntries`). */
export const PLAN_SLOTS = 5;
/** A plan this short, with this many candidates to choose from, breaks an invariant. */
export const PLAN_MIN = 3;

/** A judged term the planner may take: the reader's verdict, and the case's facts about the term. */
export interface PlanCandidate {
  term: TermCase;
  verdict: Opportunity;
}

/** One planned slot as a selector returns it. */
export interface SelectedSlot {
  candidate: PlanCandidate;
  /** The product's label for the slot, when the selector has one ("t1", "t3", ...). */
  tier?: string;
  /** Planned by relaxing a plan rule: said on the screen as "Lower confidence". */
  relaxed?: boolean;
}

export interface Selection {
  planned: SelectedSlot[];
  /** The first article, or null when the selector's rule chose none. */
  first: PlanCandidate | null;
  /** Which rule chose the first article, in the selector's words. */
  firstRule: string;
  /** Candidates the selector could have planned: the invariant's "enough candidates". */
  eligible: number;
}

export interface PlanSelector {
  name: string;
  select(c: DecisionCase, candidates: readonly PlanCandidate[], slots: number): Selection;
}

/** A verdict the planner may schedule: approved, on a results page an article can win. */
export function editorialApproval(o: Opportunity | null | undefined): boolean {
  return o?.status === "qualified" && (o.format === "article" || o.format === "mixed");
}

/** The candidates in the given order, less later phrasings of a search already in the list. */
export function oneBySearch<T extends PlanCandidate>(ordered: readonly T[], languageCode: string): T[] {
  const topics = ordered.map((candidate) => ({ candidate, term: candidate.term.term, organicUrls: candidate.verdict.organicUrls ?? null, stage: "candidate" as const }));
  const repeats = clusterByIntent(topics, intentLanguage(languageCode));
  return topics.filter((t) => !repeats.has(t)).map((t) => t.candidate);
}

/** Winnability as the recommender computes it, from the case's stored facts. */
export function reachOf(c: DecisionCase, t: TermCase): number {
  return winnability(t.difficulty ?? null, t.volume ?? 0, c.authority ?? null);
}

/**
 * The #263 planner, for comparison: approvals ordered measured before
 * unmeasured, then by the recommender's volume-times-winnability, five
 * taken, the first of them written first. Its floor (not_editorial pages
 * promoted as lower confidence) is not replayed: it read a flag the reader
 * no longer writes.
 */
export const VOLUME_FIRST: PlanSelector = {
  name: "volume first (#263)",
  select(c, candidates, slots) {
    const score = (p: PlanCandidate) => (typeof p.term.volume === "number" ? volumeScore(p.term.volume) : 15) * reachOf(c, p.term);
    const unmeasured = (p: PlanCandidate) => Number(typeof p.term.volume !== "number");
    const approved = candidates.filter((p) => editorialApproval(p.verdict));
    const ordered = [...approved].sort((a, b) => unmeasured(a) - unmeasured(b) || score(b) - score(a) || a.term.term.localeCompare(b.term.term));
    const distinct = oneBySearch(ordered, c.languageCode);
    const planned = distinct.slice(0, slots).map((candidate) => ({ candidate }));
    return { planned, first: planned[0]?.candidate ?? null, firstRule: planned.length ? "plan[0]" : "none", eligible: distinct.length };
  },
};

/** Every selector the report compares, the product's first. */
export const PLAN_SELECTORS: readonly PlanSelector[] = [VOLUME_FIRST];

// ── Scoring ───────────────────────────────────────────────────────────────

const WRONG_FIRST: ReadonlySet<TopicLabel> = new Set(["needs_page", "not_editorial", "buyer_mismatch", "existing_page"]);

export interface SlotScore {
  term: string;
  tier: string | null;
  relaxed: boolean;
  /** The label's verdict, or null when nobody labelled the term. */
  label: TopicLabel | null;
  labelValue: number | null;
  /** The reader's value grade, after code's cap, when it gave one. */
  productValue: number | null;
  /** Labelled and right: labelled qualified, and not graded value 0. Null when unlabelled. */
  correct: boolean | null;
}

export interface CasePlanScore {
  caseId: string;
  selector: string;
  /** Judged terms offered to the planner (kept by the buyer test, with a verdict). */
  candidates: number;
  eligible: number;
  planned: SlotScore[];
  slots: { labelled: number; correct: number; unlabelled: number; precision: number | null };
  first: {
    term: string | null;
    rule: string;
    /** correct / wrong by the label; unlabelled when nobody labelled it; none when nothing was chosen. */
    outcome: "correct" | "wrong" | "unlabelled" | "none";
    why: string;
  };
  topOfFunnel: { product: number; labelled: number };
  brandPlanned: string[];
  pageTypeInPlan: { product: string[]; labelled: string[] };
  /** The invariants this plan breaks, in words; empty when it keeps them all. */
  violations: string[];
}

/** The businesses a phrase may be a search FOR: its rivals and the site itself. */
function brandNames(c: DecisionCase): string[] {
  const b = c.business;
  return [...(b.competitors ?? []), ...(b.searchRivals ?? []), c.domain, ...(b.name ? [b.name] : [])].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/** The value a verdict carries, when the reader graded one. */
function valueOf(o: Opportunity): number | null {
  const v = (o as { value?: unknown }).value;
  return typeof v === "number" ? v : null;
}

type FirstOutcome = Pick<CasePlanScore["first"], "outcome" | "why">;

function firstOutcome(first: PlanCandidate | null): FirstOutcome {
  if (!first) return { outcome: "none", why: "no topic met the rule" };
  const label = first.term.label.verdict ?? null;
  if (!label || label === "needs_serp") return { outcome: "unlabelled", why: "the chosen topic has no verdict label" };
  if (WRONG_FIRST.has(label)) return { outcome: "wrong", why: `labelled ${label}` };
  const value = first.term.label.value ?? valueOf(first.verdict);
  if (value === null || value === undefined) return { outcome: "unlabelled", why: "no value grade on either side" };
  if (value < 2) return { outcome: "wrong", why: `value ${value}${first.term.label.value === undefined ? " (the reader's grade: no value label)" : ""}` };
  return { outcome: "correct", why: `labelled ${label}, value ${value}${first.term.label.value === undefined ? " (the reader's grade)" : ""}` };
}

/** The plan a selector makes for a case, scored against the case's labels. */
export function scorePlan(c: DecisionCase, candidates: readonly PlanCandidate[], selector: PlanSelector, slots = PLAN_SLOTS): CasePlanScore {
  const selection = selector.select(c, candidates, slots);
  const names = brandNames(c);
  const planned: SlotScore[] = selection.planned.map((s) => {
    const label = s.candidate.term.label.verdict && s.candidate.term.label.verdict !== "needs_serp" ? s.candidate.term.label.verdict : null;
    const labelValue = s.candidate.term.label.value ?? null;
    return {
      term: s.candidate.term.term,
      tier: s.tier ?? null,
      relaxed: Boolean(s.relaxed),
      label,
      labelValue,
      productValue: valueOf(s.candidate.verdict),
      correct: label ? label === "qualified" && labelValue !== 0 : null,
    };
  });
  const labelled = planned.filter((p) => p.correct !== null);
  const correct = labelled.filter((p) => p.correct).length;
  const first = firstOutcome(selection.first);
  const brandPlanned = selection.planned.map((s) => s.candidate.term.term).filter((term) => namedIn(term, names));
  const productPageType = selection.planned.filter((s) => !editorialApproval(s.candidate.verdict)).map((s) => s.candidate.term.term);
  const labelledPageType = planned.filter((p) => p.label === "needs_page" || p.label === "not_editorial").map((p) => p.term);
  const score: CasePlanScore = {
    caseId: c.id,
    selector: selector.name,
    candidates: candidates.length,
    eligible: selection.eligible,
    planned,
    slots: { labelled: labelled.length, correct, unlabelled: planned.length - labelled.length, precision: labelled.length ? correct / labelled.length : null },
    first: { term: selection.first?.term.term ?? null, rule: selection.firstRule, ...first },
    topOfFunnel: {
      product: selection.planned.filter((s) => s.tier === "t3" || s.candidate.verdict.funnel === "audience").length,
      labelled: planned.filter((p) => p.labelValue === 1).length,
    },
    brandPlanned,
    pageTypeInPlan: { product: productPageType, labelled: labelledPageType },
    violations: [],
  };
  score.violations = planInvariants(score, Math.min(slots, PLAN_MIN));
  return score;
}

/**
 * What every plan must keep, whatever the labels say. Checked on the public
 * sample on every pull request (lib/evals/__tests__), and by the CLI's
 * `--require-invariants` on a private case set:
 *
 *   a plan of at least `min` topics when at least `min` could be planned
 *   no brand or navigation term for one business
 *   nothing whose own verdict is not an editorial approval (needs_page,
 *   not_editorial and the rest never reach the blog plan)
 */
export function planInvariants(score: Pick<CasePlanScore, "eligible" | "planned" | "brandPlanned" | "pageTypeInPlan">, min = PLAN_MIN): string[] {
  const out: string[] = [];
  if (score.eligible >= min && score.planned.length < min) out.push(`planned ${score.planned.length} of ${score.eligible} plannable topics (at least ${min} expected)`);
  if (score.brandPlanned.length) out.push(`planned a search for one business: ${score.brandPlanned.join(", ")}`);
  if (score.pageTypeInPlan.product.length) out.push(`planned a topic the reader did not approve as editorial: ${score.pageTypeInPlan.product.join(", ")}`);
  return out;
}

/** Totals across cases, one selector. */
export interface PlanTotals {
  selector: string;
  cases: number;
  slots: { labelled: number; correct: number; unlabelled: number; precision: number | null };
  first: Record<CasePlanScore["first"]["outcome"], number>;
  topOfFunnel: number;
  brandPlanned: number;
  pageTypeInPlan: { product: number; labelled: number };
  violations: number;
}

export function planTotals(scores: readonly CasePlanScore[], selector: string): PlanTotals {
  const mine = scores.filter((s) => s.selector === selector);
  const sum = (pick: (s: CasePlanScore) => number) => mine.reduce((n, s) => n + pick(s), 0);
  const labelled = sum((s) => s.slots.labelled);
  const correct = sum((s) => s.slots.correct);
  const first = { correct: 0, wrong: 0, unlabelled: 0, none: 0 };
  for (const s of mine) first[s.first.outcome]++;
  return {
    selector,
    cases: mine.length,
    slots: { labelled, correct, unlabelled: sum((s) => s.slots.unlabelled), precision: labelled ? correct / labelled : null },
    first,
    topOfFunnel: sum((s) => s.topOfFunnel.product),
    brandPlanned: sum((s) => s.brandPlanned.length),
    pageTypeInPlan: { product: sum((s) => s.pageTypeInPlan.product.length), labelled: sum((s) => s.pageTypeInPlan.labelled.length) },
    violations: sum((s) => s.violations.length),
  };
}

/**
 * The reader's value grade against the label, where both exist: a grade of
 * 2 or more is the positive class (a topic worth a revenue slot). Reported,
 * not required: the labels come from three sites.
 */
export function valueAgreement(candidates: readonly PlanCandidate[]): { tp: number; fn: number; tn: number; fp: number; tpr: number | null; tnr: number | null } {
  let tp = 0, fn = 0, tn = 0, fp = 0;
  for (const p of candidates) {
    const label = p.term.label.value;
    const product = valueOf(p.verdict);
    if (label === undefined || product === null) continue;
    if (label >= 2) { if (product >= 2) tp++; else fn++; }
    else if (product >= 2) fp++;
    else tn++;
  }
  return { tp, fn, tn, fp, tpr: tp + fn ? tp / (tp + fn) : null, tnr: tn + fp ? tn / (tn + fp) : null };
}

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const cell = (text: string | null | undefined) => (text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** The plan section of the report: totals per selector, then each case's plan. */
export function renderPlanMarkdown(scores: readonly CasePlanScore[], value?: ReturnType<typeof valueAgreement>): string {
  if (!scores.length) return "";
  const selectors = [...new Set(scores.map((s) => s.selector))];
  const lines = ["## plan", "", "The planner's selection replayed over the reader's verdicts (lib/evals/plan.ts).", ""];
  lines.push("| selector | slot precision | unlabelled slots | first article right | wrong | unlabelled | none | top of funnel | brand planned | page type (product / labelled) | invariant breaks |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const name of selectors) {
    const t = planTotals(scores, name);
    lines.push(`| ${name} | ${t.slots.correct}/${t.slots.labelled} (${pct(t.slots.precision)}) | ${t.slots.unlabelled} | ${t.first.correct} | ${t.first.wrong} | ${t.first.unlabelled} | ${t.first.none} | ${t.topOfFunnel} | ${t.brandPlanned} | ${t.pageTypeInPlan.product} / ${t.pageTypeInPlan.labelled} | ${t.violations} |`);
  }
  lines.push("");
  if (value && value.tp + value.fn + value.tn + value.fp > 0) {
    lines.push(`Value grade against the label (>= 2 is positive): TPR ${pct(value.tpr)} (${value.tp}/${value.tp + value.fn}), TNR ${pct(value.tnr)} (${value.tn}/${value.tn + value.fp}).`, "");
  }
  for (const s of scores) {
    lines.push(`### ${s.caseId} - ${s.selector}`, "", `${s.planned.length} planned from ${s.eligible} plannable of ${s.candidates} judged. First article: ${s.first.term ? `"${cell(s.first.term)}"` : "none"} (${s.first.rule}): **${s.first.outcome}**, ${cell(s.first.why)}.`, "");
    if (s.planned.length) {
      lines.push("| # | term | tier | label | label value | reader value | right |", "|---:|---|---|---|---:|---:|---|");
      s.planned.forEach((p, i) => lines.push(`| ${i + 1} | ${cell(p.term)} | ${p.tier ?? "–"}${p.relaxed ? " (lower confidence)" : ""} | ${p.label ?? "unlabelled"} | ${p.labelValue ?? "–"} | ${p.productValue ?? "–"} | ${p.correct === null ? "–" : p.correct ? "yes" : "no"} |`));
      lines.push("");
    }
    if (s.violations.length) lines.push(...s.violations.map((v) => `- invariant broken: ${cell(v)}`), "");
  }
  return `${lines.join("\n")}\n`;
}
