// ---------------------------------------------------------------------------
// A visibility sweep as a run: planned, posted over days, collected, closed
// ---------------------------------------------------------------------------
//
// The first tracker probed live, one answer per prompt per engine, at most 24
// in one invocation across every workspace, and then marked the workspace
// measured for seven days whether or not it had finished - so a ten-prompt set
// on four engines was measured 24/40 of the way and reported as a sweep.
//
// A run fixes its plan when it starts (prompts x surfaces x samples, in the
// settings row) and works through it on the standard queue: each daily
// invocation collects what has finished, posts the next day's slice, and
// closes the run once every sample is in or the week is up. Samples are spread
// over five days because answers drift within a day as well as between them;
// a hundred answers taken in one minute are closer to one answer than to a
// hundred. A run that captured less than 95% of its plan closes `partial`, and
// says so, instead of passing for a complete measurement.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DataForSEOError, get, post } from "@/lib/seo/client";
import { classifyAnswer } from "./ai-visibility";
import {
  GEO_SURFACES,
  buildTask,
  isStillQueued,
  parseSurfaceResult,
  taskGetPath,
  taskPostPath,
  type GeoSurface,
} from "./surfaces";

/** Days a run posts over. Two more are left for the queue to drain before the next run. */
export const POST_DAYS = 5;
/** A run older than this closes with whatever it has. */
export const RUN_MAX_DAYS = 8;
/** A queued task not back after this is given up on. DataForSEO keeps results three days. */
export const PENDING_MAX_HOURS = 72;
/** A complete run captured at least this share of its plan. */
export const COMPLETE_SHARE = 0.95;

export interface RunSettings {
  surfaces: GeoSurface[];
  samples: number;
  prompts: Array<{ id: string; prompt: string }>;
  languageCode: string;
  locationCode: number;
  brandName: string;
  brandDomain: string;
}

export interface PlanEntry {
  promptId: string;
  prompt: string;
  surface: GeoSurface;
  sample: number;
}

export const plannedCount = (s: RunSettings) => s.prompts.length * s.surfaces.length * s.samples;

/**
 * The i-th sample of a run. Ordered sample-major, so the first slice asks
 * every prompt on every surface once and each later slice repeats the set: a
 * run cut short is still a balanced measurement, just a smaller one.
 */
export function planEntry(s: RunSettings, i: number): PlanEntry {
  const cells = s.prompts.length * s.surfaces.length;
  const cell = i % cells;
  const p = s.prompts[Math.floor(cell / s.surfaces.length)];
  return {
    promptId: p.id,
    prompt: p.prompt,
    surface: s.surfaces[cell % s.surfaces.length],
    sample: Math.floor(i / cells) + 1,
  };
}

/** How many samples one daily invocation posts for a run of this size. */
export const dailySlice = (planned: number) => Math.ceil(planned / POST_DAYS);

/** How a finished run is recorded. */
export function closingStatus(planned: number, captured: number): "complete" | "partial" {
  return planned > 0 && captured >= Math.ceil(planned * COMPLETE_SHARE) ? "complete" : "partial";
}

/** Settings for a workspace's next run. */
export function runSettings(options: {
  prompts: Array<{ id: string; prompt: string }>;
  samples: number | null | undefined;
  languageCode: string | null | undefined;
  locationCode: number | null | undefined;
  brandName: string;
  brandDomain: string;
}): RunSettings {
  return {
    surfaces: [...GEO_SURFACES],
    samples: Math.min(30, Math.max(1, Math.round(options.samples ?? 5))),
    prompts: options.prompts,
    languageCode: options.languageCode || "en",
    locationCode: options.locationCode || 2840,
    brandName: options.brandName,
    brandDomain: options.brandDomain,
  };
}

/** Stops a long invocation before the platform does. */
export type Deadline = () => boolean;

export type RunRow = { id: string; workspace_id: string; planned: number; settings: RunSettings; started_at: string };

/**
 * Post the next slice of a run. Each sample is written first and posted
 * second, so a post that is billed always has a row to land in, and the row's
 * id is the task's tag.
 */
export async function postNextSlice(
  db: SupabaseClient,
  run: RunRow,
  budget: { posts: number; deadline: Deadline },
): Promise<{ posted: number; refused: number }> {
  const { count } = await db
    .from("geo_results")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", run.workspace_id)
    .eq("run_id", run.id);
  const done = count ?? 0;
  const end = Math.min(run.planned, done + dailySlice(run.planned), done + budget.posts);
  let posted = 0;
  let refused = 0;

  for (let i = done; i < end && !budget.deadline(); i++) {
    const entry = planEntry(run.settings, i);
    const { data: row, error } = await db
      .from("geo_results")
      .insert({
        workspace_id: run.workspace_id,
        run_id: run.id,
        prompt_id: entry.promptId,
        prompt: entry.prompt,
        engine: entry.surface,
        surface: "app",
        sample: entry.sample,
        model: entry.surface,
        mentioned: false,
        cited: false,
        status: "pending",
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(`geo_results insert failed: ${error?.message ?? "no row"}`);

    try {
      const res = await post(taskPostPath(entry.surface), [
        buildTask({
          prompt: entry.prompt,
          languageCode: run.settings.languageCode,
          locationCode: run.settings.locationCode,
          tag: row.id as string,
        }),
      ]);
      const task = res.tasks?.[0];
      if (task?.status_code === 20100 && task.id) {
        await db.from("geo_results").update({ task_id: task.id, cost_usd: task.cost ?? 0 }).eq("id", row.id);
        posted += 1;
      } else {
        await failRow(db, row.id as string, task ? `[${task.status_code}] ${task.status_message}` : "no task returned");
        refused += 1;
      }
    } catch (err) {
      await failRow(db, row.id as string, err instanceof Error ? err.message : "post failed");
      refused += 1;
    }
    budget.posts -= 1;
  }
  return { posted, refused };
}

async function failRow(db: SupabaseClient, id: string, error: string): Promise<void> {
  await db.from("geo_results").update({ status: "failed", error }).eq("id", id);
}

/**
 * Collect queued samples that have finished. Row-driven rather than through
 * tasks_ready, so it is idempotent and never touches the account's other
 * queued work: a row is pending until its own task answers.
 */
export async function collectPending(
  db: SupabaseClient,
  budget: { gets: number; deadline: Deadline },
): Promise<{ collected: number; failed: number; waiting: number }> {
  const { data: rows } = await db
    .from("geo_results")
    .select("id, run_id, engine, task_id, checked_at")
    .eq("status", "pending")
    .order("checked_at", { ascending: true })
    .limit(budget.gets);

  const settingsByRun = new Map<string, RunSettings>();
  let collected = 0;
  let failed = 0;
  let waiting = 0;

  for (const row of rows ?? []) {
    if (budget.deadline()) break;
    const ageHours = (Date.now() - new Date(row.checked_at as string).getTime()) / 3_600_000;

    // Written, then the post never recorded a task: the invocation died between
    // the two. Nothing will ever answer it.
    if (!row.task_id) {
      if (ageHours > 1) {
        await failRow(db, row.id as string, "never posted");
        failed += 1;
      }
      continue;
    }

    const runId = row.run_id as string;
    if (!settingsByRun.has(runId)) {
      const { data: run } = await db.from("geo_runs").select("settings").eq("id", runId).single();
      if (run) settingsByRun.set(runId, run.settings as RunSettings);
    }
    const settings = settingsByRun.get(runId);
    if (!settings) continue;

    const surface = row.engine as GeoSurface;
    try {
      const res = await get(taskGetPath(surface, row.task_id as string));
      const parsed = parseSurfaceResult(surface, res.tasks?.[0]?.result?.[0]);
      if (!parsed) {
        await failRow(db, row.id as string, "no answer returned");
        failed += 1;
        continue;
      }
      const facts = classifyAnswer({
        answer: parsed.answer,
        citations: parsed.citations,
        brands: parsed.brands,
        brandName: settings.brandName,
        brandDomain: settings.brandDomain,
      });
      await db
        .from("geo_results")
        .update({
          status: "ok",
          model: parsed.model,
          answer: parsed.answer,
          mentioned: facts.mentioned,
          cited: facts.cited,
          citations: parsed.citations,
          competitor_domains: facts.competitorDomains,
          brands: facts.brands,
          fan_out_queries: parsed.fanOutQueries,
          checked_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      collected += 1;
    } catch (err) {
      const queued = err instanceof DataForSEOError && isStillQueued(err.statusCode);
      if (queued && ageHours < PENDING_MAX_HOURS) {
        waiting += 1;
        continue;
      }
      await failRow(db, row.id as string, queued ? "expired in the queue" : err instanceof Error ? err.message : "collect failed");
      failed += 1;
    }
  }
  return { collected, failed, waiting };
}

/**
 * Recount a run from its rows and close it when it is done: every sample
 * posted and none pending, or past RUN_MAX_DAYS, when what is still pending is
 * given up on. The counts are always recomputed, never incremented, so a crash
 * between two writes cannot leave them wrong.
 */
export async function settleRun(db: SupabaseClient, run: RunRow): Promise<"running" | "complete" | "partial"> {
  const { data: rows } = await db
    .from("geo_results")
    .select("status, cost_usd")
    .eq("workspace_id", run.workspace_id)
    .eq("run_id", run.id);
  const all = rows ?? [];
  const pending = all.filter((r) => r.status === "pending").length;
  const ageDays = (Date.now() - new Date(run.started_at).getTime()) / 86_400_000;
  const expired = ageDays > RUN_MAX_DAYS;

  if (expired && pending) {
    await db
      .from("geo_results")
      .update({ status: "failed", error: "run closed before it was collected" })
      .eq("workspace_id", run.workspace_id)
      .eq("run_id", run.id)
      .eq("status", "pending");
  }

  const captured = all.filter((r) => r.status === "ok").length;
  const failed = all.length - captured - (expired ? 0 : pending);
  const cost = all.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  const finished = expired || (all.length >= run.planned && pending === 0);
  const status = finished ? closingStatus(run.planned, captured) : "running";

  await db
    .from("geo_runs")
    .update({
      captured,
      failed,
      cost_usd: Math.round(cost * 100000) / 100000,
      status,
      ...(finished ? { finished_at: new Date().toISOString() } : {}),
    })
    .eq("id", run.id);
  return status;
}
