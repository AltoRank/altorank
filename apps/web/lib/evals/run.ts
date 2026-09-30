// ---------------------------------------------------------------------------
// Loading a case directory, running the decisions, capturing evidence
// ---------------------------------------------------------------------------
//
// A case directory:
//
//   <dir>/cases/*.json      one DecisionCase per business
//   <dir>/claims/*.json     ClaimCases; their `pages` are paths relative to the file
//   <dir>/recordings/       stored model answers, one file per prompt hash
//   <dir>/reports/          what `--out` writes, if pointed here
//
// Nothing is read from a database and nothing is written outside `<dir>`.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SerpData } from "@/lib/seo/brief-data";
import type { PageFetcher } from "@/lib/seo/citation-check";
import { judgeCase, planCandidates, pipelineOf, runBuyerFit, runFactCheck, runQualification } from "./decisions";
import { PLAN_SELECTORS, scorePlan, valueAgreement, type CasePlanScore, type PlanCandidate } from "./plan";
import { Budget, BudgetExceededError, Recorder, type ModelClient, type RecorderMode } from "./recorder";
import { scoreDecision, type DecisionScore } from "./score";
import { caseFunnels, type CaseFunnel } from "./funnel";
import type { ClaimCase, DecisionCase, DecisionName, Scored } from "./types";

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f));
}

export function loadCases(dir: string): Array<{ file: string; value: DecisionCase }> {
  return jsonFiles(path.join(dir, "cases")).map((file) => ({ file, value: JSON.parse(readFileSync(file, "utf8")) as DecisionCase }));
}

export function loadClaims(dir: string): Array<{ file: string; value: ClaimCase }> {
  return jsonFiles(path.join(dir, "claims")).map((file) => ({ file, value: JSON.parse(readFileSync(file, "utf8")) as ClaimCase }));
}

export function saveJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export interface EvalOptions {
  dir: string;
  mode: RecorderMode;
  model: string;
  rate: { input: number; output: number };
  decisionModel?: string;
  rates?: Record<string, { input: number; output: number }>;
  maxUsd: number;
  only?: DecisionName[];
  caseIds?: string[];
  client?: ModelClient;
  budget?: Budget;
}

export interface EvalResult {
  items: Scored[];
  scores: DecisionScore[];
  recorder: Recorder;
  /** Set when the run stopped at its spend cap; the scores cover what ran before it. */
  stoppedAt?: string;
  /** Per case, the pipeline items as the planner's funnel: labels and product side by side. */
  funnels: CaseFunnel[];
  /** Per case and selector, the plan made from the reader's verdicts (./plan.ts). Empty unless `plan` ran. */
  plans: CasePlanScore[];
  /** The reader's value grades against the value labels, over every candidate. */
  value: ReturnType<typeof valueAgreement>;
}

export async function runEvals(options: EvalOptions): Promise<EvalResult> {
  const recorder = new Recorder({ dir: options.dir, mode: options.mode, model: options.model, rate: options.rate, decisionModel: options.decisionModel, rates: options.rates, maxUsd: options.maxUsd, client: options.client }, options.budget);
  const wanted = (d: DecisionName) => !options.only?.length || options.only.includes(d);
  const cases = loadCases(options.dir).map((c) => c.value).filter((c) => !options.caseIds?.length || options.caseIds.includes(c.id));
  const claims = loadClaims(options.dir).filter((c) => !options.caseIds?.length || options.caseIds.includes(c.value.id));
  const fit: Scored[] = [];
  const qualification: Scored[] = [];
  const facts: Scored[] = [];
  const plans: CasePlanScore[] = [];
  const candidates: PlanCandidate[] = [];
  let stoppedAt: string | undefined;
  try {
    for (const c of cases) {
      const caseFit = wanted("buyer-fit") || wanted("pipeline") || wanted("plan") ? await runBuyerFit(c, recorder.ask) : [];
      fit.push(...caseFit);
      // The plan reads every judgeable term, labelled or not: what the
      // planner would have to choose from. Judged once, shared with the
      // qualification score.
      const judged = wanted("plan") ? await judgeCase(c, recorder.ask) : undefined;
      if (wanted("qualification") || wanted("pipeline")) qualification.push(...await runQualification(c, recorder.ask, judged));
      if (judged) {
        const offered = planCandidates(c, judged, caseFit);
        candidates.push(...offered);
        for (const selector of PLAN_SELECTORS) plans.push(scorePlan(c, offered, selector));
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err;
    stoppedAt = err.message;
  }
  if (wanted("fact-check")) {
    for (const { file, value } of claims) {
      const base = path.dirname(file);
      facts.push(...await runFactCheck(value, (relative) => {
        const page = path.join(base, relative);
        return existsSync(page) ? readFileSync(page, "utf8") : null;
      }));
    }
  }
  const items: Scored[] = [];
  const scores: DecisionScore[] = [];
  const add = (d: DecisionName, list: Scored[]) => {
    if (!wanted(d) || !list.length) return;
    items.push(...list);
    scores.push(scoreDecision(d, list));
  };
  add("buyer-fit", fit);
  add("qualification", qualification);
  add("pipeline", pipelineOf(fit, qualification, cases));
  add("fact-check", facts);
  return { items, scores, recorder, stoppedAt, funnels: caseFunnels(items), plans, value: valueAgreement(candidates) };
}

/** What a live run would buy, priced before anything is spent. */
export async function planEvals(options: Omit<EvalOptions, "mode" | "client">): Promise<{ calls: number; upperUsd: number; typicalUsd: number }> {
  // "plan" here is the recorder's pricing mode; the plan decision prices as the judge calls it makes.
  const { recorder } = await runEvals({ ...options, mode: "plan", only: (options.only ?? []).filter((d) => d !== "fact-check") });
  const planned = [...recorder.planned.values()];
  return {
    calls: planned.length,
    upperUsd: planned.reduce((sum, p) => sum + p.upperUsd, 0),
    typicalUsd: planned.reduce((sum, p) => sum + p.typicalUsd, 0),
  };
}

// ── Evidence capture (live, opt-in) ────────────────────────────────────────

/**
 * Buy the results page for every term that has none yet (`serp` absent; an
 * explicit null means "labelled without one") and write it into the case.
 * Each page is reserved against the budget before it is bought.
 */
export async function captureSerps(options: {
  dir: string;
  budget: Budget;
  costPerPage: number;
  fetchSerp: (term: string, locale: { languageCode: string; locationCode: number }) => Promise<SerpData>;
  caseIds?: string[];
  log?: (line: string) => void;
}): Promise<{ bought: number; failed: string[] }> {
  let bought = 0;
  const failed: string[] = [];
  for (const { file, value } of loadCases(options.dir)) {
    if (options.caseIds?.length && !options.caseIds.includes(value.id)) continue;
    for (const t of value.terms) {
      if (t.serp !== undefined) continue;
      options.budget.reserve(options.costPerPage);
      try {
        const serp = await options.fetchSerp(t.term, { languageCode: value.languageCode, locationCode: value.locationCode });
        options.budget.charge(options.costPerPage);
        t.serp = { organic: serp.organic, capturedAt: new Date().toISOString() };
        bought++;
        options.log?.(`captured ${value.id}: ${t.term} (${serp.organic.length} results)`);
      } catch (err) {
        options.budget.charge(options.costPerPage);
        failed.push(`${value.id}: ${t.term}: ${err instanceof Error ? err.message : String(err)}`);
      }
      saveJson(file, value);
    }
  }
  return { bought, failed };
}

/** Store a copy of every cited page a claim case has no copy of yet, as the citation check's own fetcher reads it. */
export async function capturePages(options: { dir: string; fetcher: PageFetcher; log?: (line: string) => void }): Promise<{ stored: number; failed: string[] }> {
  let stored = 0;
  const failed: string[] = [];
  for (const { file, value } of loadClaims(options.dir)) {
    for (const [url, relative] of Object.entries(value.pages)) {
      const target = path.join(path.dirname(file), relative);
      if (existsSync(target)) continue;
      try {
        const { status, body } = await options.fetcher(url);
        if (status < 200 || status >= 300 || !body) throw new Error(`HTTP ${status}`);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, body);
        stored++;
        options.log?.(`stored ${url} (${body.length} chars)`);
      } catch (err) {
        failed.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { stored, failed };
}
