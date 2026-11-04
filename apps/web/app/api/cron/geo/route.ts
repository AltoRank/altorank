import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getQuota, entitledToScheduledWork } from "@/lib/billing/quota";
import { getLocale } from "@/lib/seo/locales";
import {
  collectPending,
  plannedCount,
  postNextSlice,
  runSettings,
  settleRun,
  type RunRow,
  type RunSettings,
} from "@/lib/geo/runs";
import { observedCron } from "@/lib/observability/cron";

/**
 * Measure whether AI answers name the client.
 *
 *   GET /api/cron/geo    header: x-cron-secret
 *
 * The outcome half of GEO. Agent readiness says a site can be read; this says
 * whether it actually gets named when a buyer asks the question.
 *
 * Daily, and each invocation does three things in order (lib/geo/runs.ts):
 * collect the samples that have come back, post the next day's slice of every
 * running sweep, and start a sweep for each opted-in workspace whose last one
 * began a week or more ago. A sweep is prompts x surfaces x samples on the
 * standard queue at $0.0012 an answer: ten prompts on three surfaces at five
 * samples is 150 answers, about $0.18 a week.
 */

export const maxDuration = 300;

/** A new sweep at most this often per workspace. */
const MIN_INTERVAL_DAYS = 7;
/** New sweeps started per invocation. */
const MAX_NEW_RUNS = 3;
/** Ceilings per invocation, across every workspace. */
const MAX_POSTS = 150;
const MAX_GETS = 400;
/** Stop starting work well before the platform's 300 seconds. */
const SOFT_DEADLINE_MS = 240_000;

async function run(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const startedAt = Date.now();
  const deadline = () => Date.now() - startedAt > SOFT_DEADLINE_MS;
  const results: Array<Record<string, unknown>> = [];

  // 1. Collect first: it is free, and a sweep cannot close until it has.
  const collected = await collectPending(supabase, { gets: MAX_GETS, deadline });

  // The plan gate, once per account per invocation. A web-search answer is the
  // most expensive thing the product does on a schedule, so it is the last
  // place that should run unpaid - for posting, not for collecting what was
  // already bought.
  const entitled = new Map<string, boolean>();
  const isEntitled = async (accountId: string) => {
    if (!entitled.has(accountId)) {
      entitled.set(accountId, entitledToScheduledWork(await getQuota(supabase, accountId, null)));
    }
    return entitled.get(accountId)!;
  };

  // 2. Advance every running sweep: post its next slice, then recount it.
  const budget = { posts: MAX_POSTS, deadline };
  const { data: running } = await supabase
    .from("geo_runs")
    .select("id, workspace_id, planned, settings, started_at, workspaces(account_id, status, geo_tracking)")
    .eq("status", "running")
    .order("started_at", { ascending: true });

  for (const r of running ?? []) {
    const ws = (Array.isArray(r.workspaces) ? r.workspaces[0] : r.workspaces) as
      | { account_id: string; status: string; geo_tracking: boolean }
      | null;
    const runRow: RunRow = {
      id: r.id as string,
      workspace_id: r.workspace_id as string,
      planned: r.planned as number,
      settings: r.settings as RunSettings,
      started_at: r.started_at as string,
    };
    try {
      // A paused site, a switched-off workspace or a lapsed plan buys nothing
      // more; the sweep closes partial when its week is up.
      const keepPosting =
        ws && ws.geo_tracking && ws.status !== "paused" && budget.posts > 0 && (await isEntitled(ws.account_id));
      const slice = keepPosting ? await postNextSlice(supabase, runRow, budget) : { posted: 0, refused: 0 };
      const status = await settleRun(supabase, runRow);
      results.push({ runId: runRow.id, workspaceId: runRow.workspace_id, status, ...slice });
    } catch (err) {
      results.push({
        runId: runRow.id,
        workspaceId: runRow.workspace_id,
        status: "error",
        detail: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  // 3. Start sweeps for the workspaces that are due and have no sweep running.
  const cutoff = new Date(Date.now() - MIN_INTERVAL_DAYS * 86_400_000).toISOString();
  const busy = new Set((running ?? []).map((r) => r.workspace_id as string));
  const { data: due, error } = await supabase
    .from("workspaces")
    .select("id, name, domain, account_id, language, location_code, geo_samples, geo_last_checked_at")
    .eq("geo_tracking", true)
    .not("domain", "is", null)
    // A paused site buys nothing, and a probe is the most expensive thing here.
    .neq("status", "paused")
    .or(`geo_last_checked_at.is.null,geo_last_checked_at.lt.${cutoff}`)
    .order("geo_last_checked_at", { ascending: true, nullsFirst: true })
    .limit(MAX_NEW_RUNS + busy.size);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let started = 0;
  for (const ws of due ?? []) {
    if (started >= MAX_NEW_RUNS || deadline()) break;
    const workspaceId = ws.id as string;
    if (busy.has(workspaceId)) continue;
    const domain = ws.domain as string;

    try {
      if (!(await isEntitled(ws.account_id as string))) {
        results.push({ workspaceId, domain, status: "skipped", detail: "no active plan" });
        continue;
      }

      const { data: prompts } = await supabase
        .from("geo_prompts")
        .select("id, prompt")
        .eq("workspace_id", workspaceId)
        .eq("enabled", true)
        .order("created_at");

      if (!prompts?.length) {
        results.push({
          workspaceId,
          domain,
          status: "skipped",
          detail: "no prompts defined; the prompt set is the measurement and must be chosen deliberately",
        });
        continue;
      }

      const locale = getLocale((ws.language as string | null) ?? "en");
      const settings = runSettings({
        prompts: prompts.map((p) => ({ id: p.id as string, prompt: p.prompt as string })),
        samples: ws.geo_samples as number | null,
        languageCode: locale.languageCode,
        locationCode: (ws.location_code as number | null) ?? locale.locationCode,
        brandName: (ws.name as string) || domain,
        brandDomain: domain,
      });

      const { data: created, error: insertError } = await supabase
        .from("geo_runs")
        .insert({ workspace_id: workspaceId, planned: plannedCount(settings), settings })
        .select("id, workspace_id, planned, settings, started_at")
        .single();
      if (insertError || !created) throw new Error(insertError?.message ?? "run not created");

      // Stamped when the sweep starts: the interval is between sweeps, and a
      // sweep takes the week to collect.
      await supabase.from("workspaces").update({ geo_last_checked_at: new Date().toISOString() }).eq("id", workspaceId);
      started += 1;

      const runRow: RunRow = {
        id: created.id as string,
        workspace_id: workspaceId,
        planned: created.planned as number,
        settings,
        started_at: created.started_at as string,
      };
      const slice = budget.posts > 0 ? await postNextSlice(supabase, runRow, budget) : { posted: 0, refused: 0 };
      results.push({ runId: created.id, workspaceId, domain, status: "started", planned: created.planned, ...slice });
    } catch (err) {
      results.push({
        workspaceId,
        domain,
        status: "error",
        detail: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return NextResponse.json({
    collected,
    running: running?.length ?? 0,
    started,
    postBudgetRemaining: budget.posts,
    results,
  });
}

/**
 * Every run of this job lands in `system_events` (lib/observability/cron.ts):
 * a throw or a 5xx as an error, per-item failures as a warning, and a clean
 * run as one `info` row — which is the only thing anywhere that proves the
 * schedule is still firing.
 */
export const GET = observedCron("cron.geo", run);
