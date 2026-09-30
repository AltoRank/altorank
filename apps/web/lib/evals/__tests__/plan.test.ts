import { describe, expect, it } from "vitest";
import type { Opportunity } from "@/lib/keyword-research/opportunity";
import { PLAN_SELECTORS, planInvariants, planTotals, renderPlanMarkdown, scorePlan, valueAgreement, VALUE_FIRST, VOLUME_FIRST, type PlanCandidate, type PlanSelector } from "../plan";
import { planCandidates } from "../decisions";
import type { DecisionCase, TermCase } from "../types";

/**
 * The plan scorer on invented cases: a bike workshop whose highest-volume
 * approval is general interest, the shape of the 2026-09-30 failure where a
 * clinic's first article was a general-fitness topic.
 */

const CASE: DecisionCase = {
  id: "site-a",
  domain: "acme-cycles.example",
  languageCode: "en",
  locationCode: 2124,
  today: "2026-09-30",
  business: { name: "Acme Cycles", description: "Acme is a bike repair workshop: servicing, wheel building and brake work.", offerings: ["bike servicing", "wheel building"], competitors: ["spokeshop.example"] },
  terms: [],
};

let n = 0;
const approved = (extra: Partial<Opportunity> = {}): Opportunity => {
  n++;
  const urls = [`https://a${n}.example/guide`, `https://b${n}.example/guide`, `https://c${n}.example/guide`];
  return { version: 2, context: "eval", checkedAt: "2026-09-30T00:00:00.000Z", status: "qualified", reason: "r", audience: "a", buyingJob: "b", offering: "o", angle: "x", format: "article", organicUrls: urls, evidenceUrls: urls.slice(0, 2), ...extra };
};
const refused = (cause: Opportunity["cause"]): Opportunity => ({ version: 2, context: "eval", checkedAt: "2026-09-30T00:00:00.000Z", status: "rejected", cause, reason: String(cause), organicUrls: [`https://z${++n}.example/`] });
const term = (t: string, label: TermCase["label"], extra: Partial<TermCase> = {}): TermCase => ({ term: t, volume: 100, label, ...extra });
const cand = (t: TermCase, verdict: Opportunity): PlanCandidate => ({ term: t, verdict });

describe("scoring a plan", () => {
  const general = cand(term("cycling for weight loss", { verdict: "qualified", value: 1 }, { volume: 9000 }), approved());
  const service = cand(term("tubeless conversion cost", { verdict: "qualified", value: 3 }, { volume: 90 }), approved());
  const problem = cand(term("brake squeal fix", { verdict: "qualified", value: 2 }, { volume: 400 }), approved());
  const thin = cand(term("wheel truing stand", { verdict: "not_editorial", value: 1 }, { volume: 800 }), approved());
  const unlabelled = cand(term("chain lube guide", {}, { volume: 300 }), approved());

  it("plans by volume under the #263 rule and grades the first article against its labels", () => {
    const score = scorePlan(CASE, [service, general, problem, thin, unlabelled], VOLUME_FIRST);
    expect(score.planned.map((p) => p.term)).toEqual(["cycling for weight loss", "wheel truing stand", "brake squeal fix", "chain lube guide", "tubeless conversion cost"]);
    // General interest by volume: the failure the value tiers exist for.
    expect(score.first).toMatchObject({ term: "cycling for weight loss", rule: "plan[0]", outcome: "wrong", why: "value 1" });
    expect(score.slots).toEqual({ labelled: 4, correct: 3, unlabelled: 1, precision: 0.75 });
    expect(score.topOfFunnel.labelled).toBe(2);
    expect(score.pageTypeInPlan).toEqual({ product: [], labelled: ["wheel truing stand"] });
    expect(score.violations).toEqual([]);
  });

  it("counts a value-0 label as a wrong slot and an unlabelled first article as unlabelled", () => {
    const noPath = cand(term("bike stand rental", { verdict: "qualified", value: 0 }, { volume: 5000 }), approved());
    const score = scorePlan(CASE, [noPath, unlabelled], VOLUME_FIRST);
    expect(score.planned.find((p) => p.term === "bike stand rental")?.correct).toBe(false);
    const first = scorePlan(CASE, [unlabelled], VOLUME_FIRST).first;
    expect(first).toMatchObject({ outcome: "unlabelled" });
    expect(scorePlan(CASE, [], VOLUME_FIRST).first).toMatchObject({ term: null, outcome: "none" });
  });

  it("uses the reader's value when the first article has no value label, and says so", () => {
    const graded = cand(term("hydraulic brake bleed", { verdict: "qualified" }), approved({ value: 3 } as Partial<Opportunity>));
    expect(scorePlan(CASE, [graded], VOLUME_FIRST).first).toMatchObject({ outcome: "correct", why: expect.stringContaining("the reader's grade") });
  });

  it("never plans a refusal under the #263 rule, and drops a later phrasing of one search", () => {
    const shared = approved();
    const a = cand(term("brake pad replacement", { verdict: "qualified" }, { volume: 500 }), shared);
    const b = cand(term("replacement brake pads", { verdict: "qualified" }, { volume: 50 }), { ...approved(), organicUrls: shared.organicUrls });
    const out = scorePlan(CASE, [a, b, cand(term("bike shop open sunday", { verdict: "needs_page" }), refused("needs_page"))], VOLUME_FIRST);
    expect(out.planned.map((p) => p.term)).toEqual(["brake pad replacement"]);
    expect(out.eligible).toBe(1);
  });
});

describe("the invariants", () => {
  const planEverything: PlanSelector = {
    name: "everything",
    select: (_c, candidates, slots) => ({ planned: candidates.slice(0, slots).map((candidate) => ({ candidate })), first: candidates[0] ?? null, firstRule: "first", eligible: candidates.length }),
  };

  it("break on a brand search, a refused verdict in the plan and a short plan with enough to choose from", () => {
    const brand = cand(term("spokeshop login", { verdict: "buyer_mismatch" }), approved());
    const page = cand(term("bike shop near the station", { verdict: "needs_page" }), refused("needs_page"));
    const score = scorePlan(CASE, [brand, page], planEverything);
    expect(score.brandPlanned).toEqual(["spokeshop login"]);
    expect(score.pageTypeInPlan.product).toEqual(["bike shop near the station"]);
    expect(score.violations).toHaveLength(2);
    // A comparison that names a rival is not a search for the rival.
    expect(scorePlan(CASE, [cand(term("spokeshop alternatives", { verdict: "qualified" }), approved())], planEverything).brandPlanned).toEqual([]);
    expect(planInvariants({ eligible: 4, planned: [], brandPlanned: [], pageTypeInPlan: { product: [], labelled: [] } })).toEqual(["planned 0 of 4 plannable topics (at least 3 expected)"]);
    expect(planInvariants({ eligible: 2, planned: [], brandPlanned: [], pageTypeInPlan: { product: [], labelled: [] } })).toEqual([]);
  });
});

describe("candidates and totals", () => {
  it("offers what the buyer test kept, on the product's answer where it was asked and the stored one otherwise", () => {
    const c: DecisionCase = { ...CASE, terms: [term("a", {}), term("b", {}), term("c", {}, { storedFit: { keep: false, reason: "no" } })] };
    const judged = new Map([["a", approved()], ["b", approved()], ["c", approved()]]);
    const fit = [{ decision: "buyer-fit" as const, caseId: "site-a", item: "b", expected: "keep", predicted: "reject", agrees: false }];
    expect(planCandidates(c, judged, fit).map((p) => p.term.term)).toEqual(["a"]);
  });

  it("adds up per selector and renders the section", () => {
    const x = cand(term("brake squeal fix", { verdict: "qualified", value: 2 }), approved());
    const scores = [scorePlan(CASE, [x], VOLUME_FIRST), scorePlan({ ...CASE, id: "site-b" }, [x], VOLUME_FIRST)];
    const t = planTotals(scores, VOLUME_FIRST.name);
    expect(t).toMatchObject({ cases: 2, slots: { labelled: 2, correct: 2, precision: 1 }, first: { correct: 2 } });
    const md = renderPlanMarkdown(scores, valueAgreement([x]));
    expect(md).toContain("## plan");
    expect(md).toContain("### site-b - volume first (#263)");
  });

  it("grades the reader's value against the label, 2 and up as the positive class", () => {
    const v = (label: 0 | 1 | 2 | 3, product?: number) => cand(term(`t${label}${product}`, { value: label }), approved(product === undefined ? {} : ({ value: product } as Partial<Opportunity>)));
    expect(valueAgreement([v(3, 3), v(2, 1), v(1, 1), v(0, 2), v(3)])).toEqual({ tp: 1, fn: 1, tn: 1, fp: 1, tpr: 0.5, tnr: 0.5, service: { n: 0, agreed: 0 } });
    const named = (label: string, product?: string) => cand(term(`s${label}${product}`, { value: 3, service: label }), approved({ value: product ? 3 : 1, ...(product ? { service: product } : {}) } as Partial<Opportunity>));
    expect(valueAgreement([named("Bike servicing", "bike servicing"), named("Wheel building", "Bike servicing"), named("none")]).service).toEqual({ n: 3, agreed: 2 });
  });
});

describe("the value-first selector: the product's planner on the same verdicts", () => {
  const graded = (value: 0 | 1 | 2 | 3, extra: Partial<Opportunity> = {}) => approved({ value, ...extra } as Partial<Opportunity>);
  it("is the product's, and scored first", () => {
    expect(PLAN_SELECTORS[0]).toBe(VALUE_FIRST);
  });
  it("puts the service topic first where volume put general interest first", () => {
    const general = cand(term("cycling for weight loss", { verdict: "qualified", value: 1 }, { volume: 9000, difficulty: 5 }), graded(1));
    const service = cand(term("tubeless conversion cost", { verdict: "qualified", value: 3 }, { volume: 90, difficulty: 10 }), graded(3, { service: "bike servicing" }));
    const problem = cand(term("brake squeal fix", { verdict: "qualified", value: 2 }, { volume: 400, difficulty: 10 }), graded(2, { service: "bike servicing" }));
    const c = { ...CASE, authority: 10 };
    const before = scorePlan(c, [general, service, problem], VOLUME_FIRST);
    const after = scorePlan(c, [general, service, problem], VALUE_FIRST);
    expect(before.first).toMatchObject({ term: "cycling for weight loss", outcome: "wrong" });
    expect(after.planned.map((p) => `${p.term}:${p.tier}`)).toEqual(["brake squeal fix:t1", "tubeless conversion cost:t1", "cycling for weight loss:t3"]);
    expect(after.first).toMatchObject({ term: "brake squeal fix", rule: "rule", outcome: "correct" });
    expect(after.topOfFunnel.product).toBe(1);
    expect(after.violations).toEqual([]);
  });
  it("fills a short plan with labelled lower-confidence slots, and keeps the floor invariant", () => {
    const tof = (t: string) => cand(term(t, { verdict: "qualified", value: 1 }), graded(1));
    const s = scorePlan(CASE, [tof("chain lube guide"), tof("saddle height guide"), tof("tyre pressure guide")], VALUE_FIRST);
    expect(s.planned.map((p) => p.relaxed)).toEqual([false, true, true]);
    expect(s.first).toMatchObject({ term: null, rule: "none", outcome: "none" });
    expect(s.violations).toEqual([]);
  });
  it("never plans a refusal or an approval on a page that is not editorial", () => {
    const page = cand(term("bike shop open sunday", { verdict: "needs_page" }), refused("needs_page"));
    const odd = cand(term("bike stand prices", { verdict: "needs_page" }), graded(3, { format: "product" }));
    const s = scorePlan(CASE, [page, odd], VALUE_FIRST);
    expect(s.planned).toEqual([]);
    expect(s.pageTypeInPlan.product).toEqual([]);
  });
});
