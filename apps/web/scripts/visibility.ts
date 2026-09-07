#!/usr/bin/env tsx
/**
 * altorank visibility <domain> --brand "Name" --prompt "..." [--prompt "..."] [--engines chat_gpt,perplexity] [--out file.json]
 *
 * The outcome half of GEO, run once, by hand, for one site: does an AI answer
 * name this brand when a buyer asks the question? The cron in
 * app/api/cron/geo does the same thing on a schedule for a workspace that has
 * opted in; this is the week-0 baseline you run before there is a workspace,
 * and the re-measure you run after the fix, so the two numbers come from the
 * same probes.
 *
 * Every probe is a paid, web-search answer (about $0.07 each, see
 * lib/geo/ai-visibility.ts). The script prints the total it spent. Nothing is
 * written to the database: the result goes to stdout and, with --out, to a
 * JSON file you keep with the case.
 *
 * Usage
 * -----
 *   npm run visibility -- example.com --brand "Example" \
 *     --prompt "best SEO agency in Brescia" --prompt "agenzia SEO Brescia" \
 *     --engines chat_gpt,perplexity --out ./tmp/example-week0.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  probeVisibility,
  summariseVisibility,
  DEFAULT_MODELS,
  AI_ENGINES,
  type AiEngine,
  type VisibilityResult,
} from "../lib/geo/ai-visibility";

function parseArgs(argv: string[]) {
  const args = { domain: "", brand: "", prompts: [] as string[], engines: ["chat_gpt", "perplexity"] as AiEngine[], out: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--brand") args.brand = next();
    else if (a === "--prompt") args.prompts.push(next());
    else if (a === "--engines") {
      const list = next().split(",").map((s) => s.trim()) as AiEngine[];
      const bad = list.filter((e) => !AI_ENGINES.includes(e));
      if (bad.length) throw new Error(`unknown engine(s): ${bad.join(", ")}; use ${AI_ENGINES.join(", ")}`);
      args.engines = list;
    } else if (a === "--out") args.out = next();
    else if (!a.startsWith("--") && !args.domain) args.domain = a;
  }
  if (!args.domain) throw new Error("domain is required");
  if (!args.brand) throw new Error("--brand is required (the name the answer would use)");
  if (!args.prompts.length) throw new Error("at least one --prompt is required; the prompt set is the measurement");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const domain = args.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const startedAt = new Date().toISOString();

  console.log(`\n${args.brand} (${domain}), ${args.prompts.length} prompts x ${args.engines.length} engines = ${args.prompts.length * args.engines.length} probes\n`);

  const results: VisibilityResult[] = [];
  for (const prompt of args.prompts) {
    for (const engine of args.engines) {
      process.stdout.write(`  ${engine.padEnd(11)} ${prompt.slice(0, 60).padEnd(60)} `);
      const r = await probeVisibility({
        probe: { prompt, engine, model: DEFAULT_MODELS[engine] },
        brandName: args.brand,
        brandDomain: domain,
      });
      results.push(r);
      if (r.error) console.log(`ERROR ${r.error}`);
      else console.log(`${r.mentioned ? "MENTIONED" : "absent   "} ${r.cited ? "CITED" : "     "} $${r.costUsd.toFixed(3)}`);
    }
  }

  const summary = summariseVisibility(results);
  console.log(`\nMention rate ${summary.mentionRate}%   Citation rate ${summary.citationRate}%   Probes ${summary.probesRun} ok, ${summary.probesFailed} failed   Spent $${summary.totalCostUsd.toFixed(3)}`);
  if (summary.topCompetitors.length) {
    console.log("\nWho gets cited instead:");
    for (const c of summary.topCompetitors.slice(0, 10)) {
      console.log(`  ${String(c.citations).padStart(3)}  ${c.domain}`);
    }
  }

  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(
      args.out,
      JSON.stringify({ domain, brand: args.brand, startedAt, engines: args.engines, models: DEFAULT_MODELS, summary, results }, null, 2),
    );
    console.log(`\nSaved ${args.out}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
