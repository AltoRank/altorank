#!/usr/bin/env tsx
/**
 * Decision evals: run AltoRank's AI decisions on stored cases and score them
 * against labels. Cases are files (lib/evals/types.ts); the public sample is
 * lib/evals/fixtures/sample, and real cases live outside this repository.
 *
 *   npm run evals -- --fixtures=DIR                 replay stored answers (free, default)
 *   npm run evals -- --fixtures=DIR --live          buy missing answers, capped by --max-usd (default 1)
 *   npm run evals -- --fixtures=DIR --capture-serp  buy results pages for terms that have none (live)
 *   npm run evals -- --fixtures=DIR --capture-pages store copies of cited pages for claim cases
 *
 * Options: --only=buyer-fit,qualification,pipeline,plan,fact-check  --case=ID[,ID]
 *          --out=DIR (writes report.md + report.json)  --worst=N  --require-complete
 *          --require-invariants (exit 1 when a plan breaks one: lib/evals/plan.ts)
 * DIR may also come from ALTORANK_EVAL_FIXTURES. Live mode reads ANTHROPIC_API_KEY
 * (and DATAFORSEO_* for --capture-serp) from the environment and nothing else.
 */
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { anthropicModel, replyText } from "@/lib/ai/models";
import { ANTHROPIC_RATES } from "@/lib/billing/spend";
import { fetchAdvancedSerp } from "@/lib/seo/brief-data";
import { setSpendReporter } from "@/lib/seo/client";
import { defaultPageFetcher } from "@/lib/seo/citation-check";
import { Budget, type ModelClient } from "@/lib/evals/recorder";
import { capturePages, captureSerps, planEvals, runEvals } from "@/lib/evals/run";
import { renderMarkdown } from "@/lib/evals/score";
import type { DecisionName } from "@/lib/evals/types";

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
}

async function main() {
  const dirArg = arg("fixtures") ?? process.env.ALTORANK_EVAL_FIXTURES;
  if (!dirArg) throw new Error("Point the harness at a case directory: --fixtures=DIR or ALTORANK_EVAL_FIXTURES.");
  const dir = path.resolve(dirArg);
  const maxUsd = Number(arg("max-usd") ?? 1);
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error("--max-usd must be a non-negative number.");
  const budget = new Budget(maxUsd);
  const only = arg("only")?.split(",").filter(Boolean) as DecisionName[] | undefined;
  const caseIds = arg("case")?.split(",").filter(Boolean);
  const log = (line: string) => console.error(line);

  if (arg("capture-pages")) {
    const out = await capturePages({ dir, fetcher: defaultPageFetcher(8_000), log });
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (arg("capture-serp")) {
    let actual = 0;
    setSpendReporter(({ costUsd }) => { actual += costUsd ?? 0; });
    const costPerPage = Number(arg("serp-usd") ?? 0.004);
    const out = await captureSerps({ dir, budget, costPerPage, fetchSerp: fetchAdvancedSerp, caseIds, log });
    console.log(JSON.stringify({ ...out, reservedUsd: budget.spentUsd, reportedByProviderUsd: actual }, null, 2));
    return;
  }

  const model = anthropicModel("structured");
  const decisionModel = anthropicModel("decision");
  const rate = ANTHROPIC_RATES[model];
  if (!rate) throw new Error(`No price known for ${model}; add it to ANTHROPIC_RATES before running evals on it.`);
  if (!ANTHROPIC_RATES[decisionModel]) throw new Error(`No price known for ${decisionModel}; add it to ANTHROPIC_RATES before running evals on it.`);
  const rates = ANTHROPIC_RATES;
  const live = Boolean(arg("live"));
  let client: ModelClient | undefined;
  if (live) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("--live needs ANTHROPIC_API_KEY in the environment.");
    const plan = await planEvals({ dir, model, rate, decisionModel, rates, maxUsd, only, caseIds });
    log(`Live run on ${model} / decisions on ${decisionModel}: ${plan.calls} unrecorded prompts, about $${plan.typicalUsd.toFixed(3)} (at most $${plan.upperUsd.toFixed(3)}), cap $${maxUsd.toFixed(2)}.`);
    if (plan.typicalUsd > maxUsd) throw new Error("The estimated cost is over the cap. Raise --max-usd or narrow with --case/--only; nothing was spent.");
    const anthropic = new Anthropic({ apiKey });
    client = async ({ model: m, prompt, maxTokens, params }) => {
      const response = await anthropic.messages.create({ model: m, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }], ...params } as Anthropic.MessageCreateParamsNonStreaming);
      return {
        text: replyText(response.content),
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
    };
  }

  const result = await runEvals({ dir, mode: live ? "live" : "replay", model, rate, decisionModel, rates, maxUsd, only, caseIds, client, budget });
  const meta: Record<string, string | number> = {
    mode: live ? "live" : "replay",
    model,
    "decision model": decisionModel,
    "stored answers used": result.recorder.hits,
    "answers bought this run": result.recorder.calls,
    "missing answers (prompt not recorded)": result.recorder.misses,
    "spent this run": `$${result.recorder.budget.spentUsd.toFixed(4)}`,
  };
  if (result.stoppedAt) meta["stopped"] = result.stoppedAt;
  const markdown = renderMarkdown({ title: "Decision evals", scores: result.scores, items: result.items, meta, worst: Number(arg("worst") ?? 25), funnels: result.funnels, plans: result.plans, value: result.value });
  const out = arg("out");
  if (out) {
    const target = path.resolve(out);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "report.md"), markdown);
    writeFileSync(path.join(target, "report.json"), `${JSON.stringify({ meta, scores: result.scores, funnels: result.funnels, plans: result.plans, value: result.value, items: result.items }, null, 2)}\n`);
    log(`Wrote ${path.join(target, "report.md")}`);
  }
  console.log(markdown);
  if (arg("require-complete") && result.recorder.misses > 0) {
    console.error(`${result.recorder.misses} prompts have no stored answer: the prompts changed since the last live run. Re-record with --live.`);
    process.exitCode = 1;
  }
  const broken = result.plans.filter((p) => p.violations.length && p.selector === result.plans[0]?.selector);
  if (arg("require-invariants") && broken.length) {
    console.error(`${broken.length} plan(s) break an invariant: ${broken.map((p) => `${p.caseId}: ${p.violations.join("; ")}`).join(" | ")}`);
    process.exitCode = 1;
  }
  if (result.stoppedAt) process.exitCode = 2;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
