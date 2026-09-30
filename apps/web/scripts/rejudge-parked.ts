// ---------------------------------------------------------------------------
// Re-judge one workspace's parked topics under the current rulebook
// ---------------------------------------------------------------------------
//
// Until 2026-09-30 every refusal parked its row for good, and most refusals
// on the two real customers' sites came from a judge that has since been
// replaced (a buyer-only rule on Haiku at temperature 1; see
// lib/keyword-research/opportunity.ts). The 30-day TTL (lib/keyword-research/
// queue.ts) only frees results-page refusals as they age. This asks again,
// now, for the rows of one workspace: the buyer test first, then the results
// page and the judge for the kept ones - the same functions the planner
// calls.
//
// DRY RUN by default: it buys the verdicts and prints before -> after, and
// writes nothing to the database, not even spend rows: a dry run's cost is
// printed here and appears nowhere in provider_spend.
// --apply writes each new verdict: a topic that qualifies now goes back to
// the queue (status new, unparked); a refusal stays parked with its new
// reason; an answer that is still pending is left as it was.
//
//   npx tsx --env-file=.env.local scripts/rejudge-parked.ts <workspace-id-or-domain>
//   npx tsx --env-file=.env.local scripts/rejudge-parked.ts <workspace-id-or-domain> --apply
//
// Options:
//   --causes=not_editorial,needs_page,thin_serp   which parked causes to ask again (default: those three)
//   --include-buyer                               also buyer_mismatch, and ask the buyer test again for every row;
//                                                 without it a row's saved buyer verdict is reused when it kept the
//                                                 term, so a results-page refusal cannot turn into a permanent
//                                                 buyer_mismatch park
//   --limit=N                                     at most N rows, best volume first (default: what --max-usd covers)
//   --max-usd=N                                   spend cap for this run (default 1.00); refused before it is passed
//
// Only rows parked by a verdict are touched: a row a person took off the plan
// (its park stamp is well after its verdict) stays where they put it.
// Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
// and DATAFORSEO_* in the environment. Run by a person against production;
// nothing schedules it.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { anthropicModel, replyText } from "@/lib/ai/models";
import { anthropicCost } from "@/lib/billing/spend";
import { samplingFor, type AskModel } from "@/lib/keyword-research/buyer-model";
import { contextKey, judgeBuyerFitFor, judgeOnResults, OPPORTUNITY_VERSION, type Opportunity, type OpportunityContext } from "@/lib/keyword-research/opportunity";
import type { FitVerdict } from "@/lib/keyword-research/buyer-fit";
import { TTL_CAUSES } from "@/lib/keyword-research/queue";
import { languageCodeOf } from "@/lib/keyword-research/locale";
import { fetchAdvancedSerp } from "@/lib/seo/brief-data";
import { setSpendReporter } from "@/lib/seo/client";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";

/** A verdict parks its row within minutes; a later stamp is a person's (lib/keyword-research/queue.ts). */
const PARKED_BY_VERDICT_MS = 60 * 60_000;
/** What one re-judged row can cost at most: its share of a buyer batch, a results page, one judge call. */
const WORST_CASE_PER_ROW_USD = 0.03;

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
}

type Row = { id: string; term: string; volume: number | null; status: string; source_url: string | null; opportunity: Opportunity | null; buyer_fit: FitVerdict | null; plan_excluded_at: string | null };

async function main() {
  const target = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!target) throw new Error("usage: rejudge-parked.ts <workspace-id-or-domain> [--apply] [--causes=...] [--include-buyer] [--limit=N] [--max-usd=N]");
  const apply = Boolean(arg("apply"));
  const causes = new Set((arg("causes") ?? [...TTL_CAUSES].join(",")).split(",").filter(Boolean));
  const includeBuyer = Boolean(arg("include-buyer"));
  if (includeBuyer) causes.add("buyer_mismatch");
  const maxUsd = Number(arg("max-usd") ?? 1);
  // The default limit is what the cap covers at the worst case, so a run
  // with no flags starts instead of refusing itself.
  const limit = Number(arg("limit") ?? Math.max(1, Math.floor(maxUsd / WORST_CASE_PER_ROW_USD)));
  if (!Number.isFinite(limit) || limit < 1 || !Number.isFinite(maxUsd) || maxUsd < 0) throw new Error("--limit and --max-usd must be positive numbers");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
  const supabase = createClient(url, key);

  const byId = /^[0-9a-f-]{36}$/.test(target);
  const { data: ws, error } = await supabase
    .from("workspaces")
    .select("id, domain, business_profile, language, location_code")
    .eq(byId ? "id" : "domain", target)
    .maybeSingle();
  if (error) throw error;
  if (!ws) throw new Error(`no workspace for ${target}`);
  const business = (ws.business_profile as BusinessProfile | null) ?? null;
  if (!business?.description) throw new Error(`${ws.domain} has no business profile to judge against`);
  const context: OpportunityContext = { domain: ws.domain as string, business, languageCode: languageCodeOf(ws.language as string | null), locationCode: (ws.location_code as number | null) ?? 2840 };
  const fingerprint = contextKey(context);

  const { data: parked, error: readError } = await supabase
    .from("keywords")
    .select("id, term, volume, status, source_url, opportunity, buyer_fit, plan_excluded_at")
    .eq("workspace_id", ws.id)
    .eq("status", "stored")
    .not("plan_excluded_at", "is", null)
    .eq("opportunity->>status", "rejected");
  if (readError) throw readError;
  const byVerdict = ((parked ?? []) as Row[]).filter((r) => {
    const cause = r.opportunity?.cause;
    if (!cause || !causes.has(cause)) return false;
    const checked = Date.parse(r.opportunity?.checkedAt ?? "");
    const stamped = Date.parse(r.plan_excluded_at ?? "");
    return Number.isFinite(checked) && Number.isFinite(stamped) && stamped - checked <= PARKED_BY_VERDICT_MS;
  });
  const rows = byVerdict.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1)).slice(0, limit);
  console.log(`${ws.domain}: ${byVerdict.length} rows parked by ${[...causes].join(", ")}; re-judging ${rows.length}${apply ? "" : " (dry run: nothing is written)"}`);
  if (!rows.length) return;
  if (rows.length * WORST_CASE_PER_ROW_USD > maxUsd) {
    throw new Error(`${rows.length} rows could cost up to $${(rows.length * WORST_CASE_PER_ROW_USD).toFixed(2)}, over --max-usd=${maxUsd}. Lower --limit or raise the cap; nothing was spent.`);
  }

  // Every paid call is counted here and nowhere else: a dry run writes no
  // spend rows either.
  let spent = 0;
  setSpendReporter(({ costUsd }) => { spent += costUsd ?? 0; });
  const anthropic = new Anthropic();
  const ask: AskModel = async (_operation, prompt, options) => {
    if (spent >= maxUsd) throw new Error(`spend cap $${maxUsd} reached ($${spent.toFixed(3)})`);
    const model = anthropicModel(options.tier ?? "structured");
    try {
      const response = await anthropic.messages.create({
        model, max_tokens: options.maxTokens, messages: [{ role: "user", content: prompt }],
        ...samplingFor(model, options.tier, options.schema),
      } as Anthropic.MessageCreateParamsNonStreaming);
      spent += anthropicCost(model, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0) ?? 0;
      return replyText(response.content);
    } catch (err) {
      console.warn(`  model call failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };

  // Without --include-buyer, a row whose saved buyer verdict kept the term is
  // not asked again: only its results page is. Only rows with no kept
  // verdict on file go to the buyer test.
  const savedKeep = (r: Row) => (!includeBuyer && r.buyer_fit?.keep === true ? r.buyer_fit : null);
  const fit = await judgeBuyerFitFor(context, rows.filter((r) => !savedKeep(r)).map((r) => r.term), { ask });
  for (const r of rows) {
    const kept = savedKeep(r);
    if (kept) fit.verdicts.set(r.term.trim().toLowerCase(), kept);
  }
  const tally = new Map<string, number>();
  for (const r of rows) {
    const before = `${r.opportunity?.cause}`;
    const verdict = fit.verdicts.get(r.term.trim().toLowerCase());
    const result: Opportunity = { version: OPPORTUNITY_VERSION, context: fingerprint, checkedAt: new Date().toISOString(), status: "pending", cause: "no_verdict", reason: "The buyer test returned no decision for this term." };
    if (verdict?.keep === false) {
      result.status = "rejected"; result.cause = "buyer_mismatch"; result.reason = verdict.reason;
    } else if (verdict?.keep === true) {
      try {
        const serp = await fetchAdvancedSerp(r.term, context);
        await judgeOnResults(result, { term: r.term, sourceUrl: r.source_url, context, verdict, organic: serp.organic }, { ask });
      } catch (err) {
        result.cause = "provider_error";
        result.reason = `Qualification could not finish: ${err instanceof Error ? err.message.slice(0, 200) : "provider call failed"}.`;
      }
    }
    if (r.volume === null) result.demand = "unmeasured";
    const after = result.status === "qualified" ? "qualified" : `${result.cause}`;
    tally.set(after, (tally.get(after) ?? 0) + 1);
    console.log(`  ${r.term}  (${r.volume ?? "unmeasured"}/mo)  ${before} -> ${after}${result.status === "qualified" ? `: ${result.angle}` : ""}`);
    if (!apply || result.status === "pending") continue;
    const patch = result.status === "qualified"
      ? { opportunity: result, buyer_fit: verdict ?? null, status: "new", plan_excluded_at: null }
      : { opportunity: result, buyer_fit: verdict ?? null, plan_excluded_at: new Date().toISOString() };
    const { error: writeError } = await supabase.from("keywords").update(patch).eq("id", r.id).eq("workspace_id", ws.id).eq("status", "stored");
    if (writeError) throw writeError;
  }
  setSpendReporter(null);
  console.log(`\n${[...tally.entries()].map(([k, n]) => `${n} ${k}`).join(", ")}. Spent about $${spent.toFixed(3)}.`);
  if (!apply) console.log("Dry run: pass --apply to write these verdicts. This run's spend was real and is not recorded in provider_spend.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
