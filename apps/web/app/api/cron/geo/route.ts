import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getQuota, entitledToScheduledWork } from "@/lib/billing/quota";
import {
  probeVisibility,
  summariseVisibility,
  DEFAULT_MODELS,
  AI_ENGINES,
  type AiEngine,
  type VisibilityResult,
} from "@/lib/geo/ai-visibility";

/**
 * Measure whether AI answers name the client.
 *
 *   GET /api/cron/geo    header: x-cron-secret
 *
 * The outcome half of GEO. Agent readiness says a site can be read; this says
 * whether it actually gets named when a buyer asks the question.
 *
 * Cost is the constraint that shapes everything here. A web-search answer runs
 * about $0.066 against $0.001 for a plain completion, so a sweep of ten prompts
 * across four engines is a few dollars. Hence: opt-in per workspace, a hard
 * ceiling per run, and a minimum interval so a misconfigured schedule cannot
 * bill the operator repeatedly for the same measurement.
 */

export const maxDuration = 300;

/** Trend needs a stable cadence, and daily re-measurement is mostly noise. */
const MIN_INTERVAL_DAYS = 7;
/** Hard ceiling on probes per invocation, across all workspaces. */
const MAX_PROBES_PER_RUN = 24;
const MAX_WORKSPACES_PER_RUN = 3;

export async function GET(request: Request) {
  const cronSecret = cronSecretFrom(request);
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const cutoff = new Date(Date.now() - MIN_INTERVAL_DAYS * 86_400_000).toISOString();

  const { data: workspaces, error } = await supabase
    .from("workspaces")
    .select("id, name, domain, agency_id, geo_last_checked_at")
    .eq("geo_tracking", true)
    .not("domain", "is", null)
    .or(`geo_last_checked_at.is.null,geo_last_checked_at.lt.${cutoff}`)
    .order("geo_last_checked_at", { ascending: true, nullsFirst: true })
    .limit(MAX_WORKSPACES_PER_RUN);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<Record<string, unknown>> = [];
  let probeBudget = MAX_PROBES_PER_RUN;

  for (const ws of workspaces ?? []) {
    const workspaceId = ws.id as string;
    const domain = ws.domain as string;
    const brandName = (ws.name as string) || domain;

    try {
      // The most expensive thing the product can do on a schedule - a
      // web-search answer is ~$0.066, and this runs every prompt across four
      // engines - so it is the last place that should run unpaid. Ten prompts
      // is about $11 a month. The toggle has no UI yet; this is here before it
      // does, not after.
      const quota = await getQuota(supabase, ws.agency_id as string, null);
      if (!entitledToScheduledWork(quota)) {
        results.push({ workspaceId, domain, status: "skipped", detail: "no active plan" });
        continue;
      }

      const { data: prompts } = await supabase
        .from("geo_prompts")
        .select("id, prompt")
        .eq("workspace_id", workspaceId)
        .eq("enabled", true);

      if (!prompts?.length) {
        results.push({
          workspaceId,
          domain,
          status: "skipped",
          detail: "no prompts defined; the prompt set is the measurement and must be chosen deliberately",
        });
        continue;
      }

      const probes: Array<{ promptId: string; prompt: string; engine: AiEngine }> = [];
      for (const p of prompts) {
        for (const engine of AI_ENGINES) {
          probes.push({ promptId: p.id as string, prompt: p.prompt as string, engine });
        }
      }

      const runnable = probes.slice(0, Math.max(0, probeBudget));
      probeBudget -= runnable.length;

      const collected: VisibilityResult[] = [];
      for (const probe of runnable) {
        const result = await probeVisibility({
          probe: { prompt: probe.prompt, engine: probe.engine, model: DEFAULT_MODELS[probe.engine] },
          brandName,
          brandDomain: domain,
        });
        collected.push(result);

        await supabase.from("geo_results").insert({
          workspace_id: workspaceId,
          prompt_id: probe.promptId,
          prompt: result.prompt,
          engine: result.engine,
          model: result.model,
          mentioned: result.mentioned,
          cited: result.cited,
          citations: result.citations,
          competitor_domains: result.competitorDomains,
          fan_out_queries: result.fanOutQueries,
          cost_usd: result.costUsd,
          error: result.error ?? null,
        });
      }

      await supabase
        .from("workspaces")
        .update({ geo_last_checked_at: new Date().toISOString() })
        .eq("id", workspaceId);

      const summary = summariseVisibility(collected);
      results.push({
        workspaceId,
        domain,
        status: "measured",
        ...summary,
        truncated: runnable.length < probes.length,
      });
    } catch (err) {
      results.push({
        workspaceId,
        domain,
        status: "error",
        detail: err instanceof Error ? err.message : "unknown error",
      });
    }

    if (probeBudget <= 0) break;
  }

  return NextResponse.json({
    checked: workspaces?.length ?? 0,
    measured: results.filter((r) => r.status === "measured").length,
    probeBudgetRemaining: probeBudget,
    results,
  });
}
