import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { analyzeWorkspace } from "@/lib/refresh/detect";
import { runRefreshTask } from "@/lib/refresh/rewrite";

/**
 * The content refresh schedule.
 *
 *   GET /api/cron/refresh    header: x-cron-secret
 *
 * Two jobs, for every workspace that has switched refreshes on:
 *
 *   analyse   weekly, or when the last pass is older than seven days: run
 *             the detectors over stored Search Console rows and raise or
 *             refresh candidates. Database only; costs nothing.
 *   rewrite   on the workspace's enabled weekdays: run the earliest due task,
 *             one per workspace per run. A model call, and one slot of the
 *             site's article pace.
 *
 * What comes out of a rewrite is an execution in `awaiting_review`. There is
 * no path from here to a CMS: the push is a button, and it applies a person's
 * hunk decisions. The one thing a misconfigured schedule can cost is a model
 * call somebody has to read.
 *
 * Daily in vercel.json. The Vercel account is on Hobby, which fails the whole
 * deployment on a sub-daily expression, and one rewrite a day per site is the
 * product's own promise ("one improvement per scheduled day"), so a second
 * scheduler would buy nothing.
 *
 * Bounded like cron/generate: two rewrites per invocation across all
 * workspaces, stalest first, and no rewrite is started past the point where
 * it could not finish inside the function's budget.
 */

export const maxDuration = 300;

/** Measured on cron/generate: about 103 s a draft. Two fit; three do not. */
const MAX_REWRITES_PER_RUN = 2;
/** Do not start a rewrite with less than this left. */
const MIN_SECONDS_FOR_REWRITE = 150;
const ANALYSIS_STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface Outcome {
  workspaceId: string;
  domain: string | null;
  analysed?: string;
  rewrite?: string;
  status: "ok" | "skipped" | "error";
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || cronSecretFrom(request) !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const supabase = createServiceClient();
  const now = new Date();
  // UTC weekday and date. The settings page says so; a timezone per site is a
  // refinement that changes which of two mornings a rewrite lands on, not
  // whether it lands.
  const weekday = now.getUTCDay();
  const today = now.toISOString().slice(0, 10);

  const { data: workspaces, error } = await supabase
    .from("workspaces")
    .select("id, domain, refresh_days, refresh_last_analyzed_at")
    .eq("refresh_enabled", true)
    .neq("status", "paused")
    // Least recently analysed first, so a capped run rotates.
    .order("refresh_last_analyzed_at", { ascending: true, nullsFirst: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Outcome[] = [];
  let rewrites = 0;

  for (const ws of workspaces ?? []) {
    const workspaceId = ws.id as string;
    const domain = (ws.domain as string | null) ?? null;
    const out: Outcome = { workspaceId, domain, status: "ok" };

    try {
      const last = ws.refresh_last_analyzed_at ? Date.parse(ws.refresh_last_analyzed_at as string) : 0;
      if (Date.now() - last > ANALYSIS_STALE_MS) {
        const a = await analyzeWorkspace(supabase, workspaceId, { now });
        out.analysed =
          a.reason === "gsc_not_connected"
            ? "skipped: Search Console is not connected"
            : `${a.pages} pages, ${a.created} new candidates, ${a.refreshed} refreshed`;
      }

      const days = (ws.refresh_days as number[] | null) ?? [];
      if (!days.includes(weekday)) {
        out.rewrite = "not a scheduled day";
      } else if (rewrites >= MAX_REWRITES_PER_RUN) {
        out.rewrite = `run limit reached (${MAX_REWRITES_PER_RUN}); the next run starts here`;
        out.status = "skipped";
      } else if ((Date.now() - startedAt) / 1000 > maxDuration - MIN_SECONDS_FOR_REWRITE) {
        out.rewrite = "not enough time left in this run";
        out.status = "skipped";
      } else {
        // One a day: a task already run today is this day's improvement.
        const { count: doneToday } = await supabase
          .from("refresh_executions")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .gte("created_at", `${today}T00:00:00Z`);
        if ((doneToday ?? 0) > 0) {
          out.rewrite = "already ran today";
        } else {
          const { data: task } = await supabase
            .from("refresh_tasks")
            .select("id, scheduled_for")
            .eq("workspace_id", workspaceId)
            .eq("status", "scheduled")
            .lte("scheduled_for", today)
            .order("scheduled_for", { ascending: true })
            .limit(1)
            .maybeSingle();
          if (!task) {
            out.rewrite = "nothing scheduled";
          } else {
            const r = await runRefreshTask(supabase, task.id as string);
            rewrites += 1;
            if (r.ok) {
              out.rewrite = `execution ${r.result.executionId}: ${r.result.changed} of ${r.result.hunks} blocks changed, ${r.result.issues} checks flagged, awaiting review`;
            } else {
              out.rewrite = `failed: ${r.error}`;
              out.status = "error";
            }
          }
        }
      }
    } catch (err) {
      out.status = "error";
      out.rewrite = err instanceof Error ? err.message : "unknown error";
    }
    results.push(out);
  }

  return NextResponse.json({
    checked: workspaces?.length ?? 0,
    rewrites,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
}
