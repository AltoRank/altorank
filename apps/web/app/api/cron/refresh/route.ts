import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { entitledToScheduledWork, getQuota } from "@/lib/billing/quota";
import { draftHoldReason } from "@/lib/billing/trial-hold";
import { analyzeWorkspace } from "@/lib/refresh/detect";
import { runRefreshTask } from "@/lib/refresh/rewrite";
import { reapStoppedTasks } from "@/lib/refresh/tasks";
import { isMissingColumn } from "@/lib/supabase/missing-column";
import { rewriteSlot, runOrder, type DueTask, type RecentRun, type RewriteSlot } from "@/lib/refresh/schedule";
import { readArticlesWhole } from "@/lib/articles/body-read";
import { describePaceBudget, readPaceBudget } from "@/lib/plan/pace-budget";
import { notifyRefreshReady } from "@/lib/email/lifecycle";
import { describeSendOutcome } from "@/lib/email/send-once";
import { observedCron } from "@/lib/observability/cron";

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
 *             one per workspace per day. A model call, and one slot of the
 *             site's article pace. A site whose last rewrite day passed
 *             without an attempt (the run's cap, a short run) gets it the next
 *             morning instead, within its weekly count.
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
 * workspaces, least recently rewritten first (lib/refresh/schedule.ts), and
 * no rewrite is started past the point where
 * it could not finish inside the function's budget. Those two slots are the
 * run's whole capacity, so they are spent only on accounts entitled to
 * scheduled work - see the gate at the top of the loop.
 *
 * A rewrite spends one slot of the site's weekly article pace - the settings
 * copy has said so since the feature shipped, and lib/plan/pace-budget.ts is
 * what makes it true. The same budget cron/generate reads; a week whose
 * articles are all written has no slot left for an improvement, and the task
 * waits for the next enabled day with room.
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

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Ids per `.in()` filter, so the request line stays short at any scale. */
const ID_CHUNK = 100;

/**
 * The due tasks and the trailing week's rewrite attempts of these sites, for
 * lib/refresh/schedule.ts.
 *
 * An attempt is a task the cron claimed (`started_at`, migration 117) or one
 * that left an execution, counted once per task. A rewrite that failed leaves
 * no execution but still spent its morning, and often its model call: counting
 * only executions let a site whose rewrites keep failing be "caught up" every
 * day instead of once a week. Before 117 only executions can be counted.
 */
async function readRunInputs(
  supabase: SupabaseClient,
  ids: string[],
  now: Date,
  today: string,
): Promise<{ due: DueTask[]; recent: RecentRun[] }> {
  const due: DueTask[] = [];
  const latest = new Map<string, RecentRun>();
  const note = (key: string, run: RecentRun) => {
    const seen = latest.get(key);
    if (!seen || Date.parse(run.created_at) > Date.parse(seen.created_at)) latest.set(key, run);
  };
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const [tasks, runs, started] = await Promise.all([
      supabase
        .from("refresh_tasks")
        .select("id, workspace_id, scheduled_for, created_at")
        .in("workspace_id", chunk)
        .eq("status", "scheduled")
        .lte("scheduled_for", today)
        .order("scheduled_for", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("refresh_executions")
        .select("task_id, workspace_id, created_at")
        .in("workspace_id", chunk)
        .gte("created_at", since),
      supabase
        .from("refresh_tasks")
        .select("id, workspace_id, started_at")
        .in("workspace_id", chunk)
        .gte("started_at", since),
    ]);
    if (tasks.error) throw new Error(`refresh_tasks: ${tasks.error.message}`);
    if (runs.error) throw new Error(`refresh_executions: ${runs.error.message}`);
    if (started.error && !isMissingColumn(started.error)) throw new Error(`refresh_tasks: ${started.error.message}`);
    due.push(...((tasks.data ?? []) as DueTask[]));
    for (const r of (runs.data ?? []) as { task_id: string | null; workspace_id: string; created_at: string }[]) {
      note(r.task_id ?? `execution:${r.created_at}`, { workspace_id: r.workspace_id, created_at: r.created_at });
    }
    if (!started.error) {
      for (const t of (started.data ?? []) as { id: string; workspace_id: string; started_at: string | null }[]) {
        if (t.started_at) note(t.id, { workspace_id: t.workspace_id, created_at: t.started_at });
      }
    }
  }
  // Earliest first across chunks too, which rewriteSlot relies on.
  due.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for) || a.created_at.localeCompare(b.created_at));
  return { due, recent: [...latest.values()] };
}

async function run(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const supabase = createServiceClient();
  const now = new Date();
  // UTC weekday and date. The settings page says so; a timezone per site is a
  // refinement that changes which of two mornings a rewrite lands on, not
  // whether it lands.
  const today = now.toISOString().slice(0, 10);

  // A rewrite the platform cut off before it could record an outcome is
  // still `running`, and nothing else ever moves it: it read "Rewriting
  // now…" and held a calendar slot for good. Before this run starts any of
  // its own, mark those failed with a sentence that says what happened.
  let stopped = 0;
  try {
    stopped = await reapStoppedTasks(supabase, now.getTime());
  } catch (err) {
    console.error("[cron/refresh] could not mark stopped rewrites:", err instanceof Error ? err.message : err);
  }

  const { data: enabled, error } = await supabase
    .from("workspaces")
    .select("id, domain, account_id, refresh_days, refresh_last_analyzed_at, auto_generate_weekly_limit")
    .eq("refresh_enabled", true)
    .neq("status", "paused")
    .order("refresh_last_analyzed_at", { ascending: true, nullsFirst: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // What each site may run today, decided up front so the run's two slots go
  // to the sites that waited longest (lib/refresh/schedule.ts): the tasks due
  // by today, and every rewrite of the trailing week.
  let due: DueTask[];
  let recent: RecentRun[];
  try {
    ({ due, recent } = await readRunInputs(supabase, (enabled ?? []).map((w) => w.id as string), now, today));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "could not read tasks" }, { status: 500 });
  }
  const slots = new Map<string, RewriteSlot>();
  for (const ws of enabled ?? []) {
    const id = ws.id as string;
    slots.set(
      id,
      rewriteSlot({
        days: (ws.refresh_days as number[] | null) ?? [],
        now,
        due: due.filter((t) => t.workspace_id === id),
        runs: recent.filter((r) => r.workspace_id === id),
      }),
    );
  }
  const workspaces = runOrder(enabled ?? [], slots, recent);

  const results: Outcome[] = [];
  let rewrites = 0;

  for (const ws of workspaces) {
    const workspaceId = ws.id as string;
    const domain = (ws.domain as string | null) ?? null;
    const out: Outcome = { workspaceId, domain, status: "ok" };

    // Nothing below is worth buying for an account that cannot ship what it
    // produces, and one thing below is bought before anything checks: a
    // rewrite pays Anthropic for its brief inside `ensureBrief`, and the only
    // quota check on this path is `generateArticle`'s, which runs after that
    // money is gone. Any signed-in member could arm the schedule, so a no-plan
    // account that had burned its free drafts paid for a brief on every
    // scheduled day and errored immediately afterwards - and, because
    // `rewrites` counts the attempt whether or not it worked, took one of the
    // run's two global slots away from a paying customer while doing it.
    //
    // `setRefreshSettings` now refuses to arm one without a plan, which is the
    // half a person sees. This is the half that holds when a plan lapses after
    // the switch was armed, and it is the one that guards the money.
    //
    // The same gate serp, geo and reports apply, for the same reason. See
    // entitledToScheduledWork.
    const quota = await getQuota(supabase, ws.account_id as string, null);
    // A trial-gated account is also a no-plan one, so the gate below would
    // stop it anyway; this names the real reason (lib/billing/trial-hold.ts).
    // A rewrite is a draft, and nothing drafts before the trial but the
    // first article, nor after a trial is cancelled.
    const held = draftHoldReason(quota);
    if (held) {
      out.status = "skipped";
      out.rewrite = held;
      results.push(out);
      continue;
    }
    if (!entitledToScheduledWork(quota)) {
      out.status = "skipped";
      out.rewrite = "no plan";
      results.push(out);
      continue;
    }

    try {
      const days = (ws.refresh_days as number[] | null) ?? [];
      let slot: RewriteSlot = slots.get(workspaceId) ?? { kind: "none", reason: "not a scheduled day" };

      const last = ws.refresh_last_analyzed_at ? Date.parse(ws.refresh_last_analyzed_at as string) : 0;
      if (Date.now() - last > ANALYSIS_STALE_MS) {
        const a = await analyzeWorkspace(supabase, workspaceId, { now, readBodies: readArticlesWhole });
        out.analysed =
          a.reason === "gsc_not_connected"
            ? "skipped: Search Console is not connected"
            : `${a.pages} pages, ${a.created} new candidates, ${a.refreshed} refreshed, ${a.retired} retired`;
        // The pass may have retired the candidate behind the task picked
        // above, which cancels that task. Pick again from what is still due
        // rather than spend one of the run's slots on a cancelled task.
        if (a.reason === "ok" && a.retired > 0 && slot.kind !== "none") {
          const fresh = await readRunInputs(supabase, [workspaceId], now, today);
          slot = rewriteSlot({ days, now, due: fresh.due, runs: recent.filter((r) => r.workspace_id === workspaceId) });
        }
      }

      const budget =
        slot.kind === "none"
          ? null
          : await readPaceBudget(supabase, workspaceId, {
              weeklyLimit: ws.auto_generate_weekly_limit as number | null,
              refreshEnabled: true,
              refreshDays: days,
              now,
            });
      if (slot.kind === "none") {
        out.rewrite = slot.reason;
      } else if (budget && budget.improvementsLeft <= 0) {
        out.rewrite = `weekly pace used: ${describePaceBudget(budget)}; the task waits for a day with room`;
      } else if (rewrites >= MAX_REWRITES_PER_RUN) {
        // The next run picks it up as a catch-up (lib/refresh/schedule.ts).
        out.rewrite = `run limit reached (${MAX_REWRITES_PER_RUN}); the next run picks it up`;
        out.status = "skipped";
      } else if ((Date.now() - startedAt) / 1000 > maxDuration - MIN_SECONDS_FOR_REWRITE) {
        out.rewrite = "not enough time left in this run; the next run picks it up";
        out.status = "skipped";
      } else {
        const r = await runRefreshTask(supabase, slot.task.id);
        // The attempt, not the success: a rewrite that failed still spent
        // the model call and the seconds this cap exists to bound. Only
        // entitled accounts reach this line, so the slot is never taken
        // from a paying customer by an account that could not use it.
        rewrites += 1;
        if (r.ok) {
          out.rewrite = `${slot.kind === "catch_up" ? `catch-up for ${slot.missed}, ` : ""}execution ${r.result.executionId}: ${r.result.changed} of ${r.result.hunks} blocks changed, ${r.result.checks} structural checks flagged, fact check ${r.result.factCheck.verdict}, awaiting review`;
          // A proposal nobody is told about is the same failure the
          // draft-ready email exists for: work done into a queue that
          // only shows itself to somebody who opens the dashboard.
          // Nothing here reaches the CMS, so the email says "proposed".
          // After the execution row is written, and never fatal.
          try {
            const sent = await notifyRefreshReady(
              supabase,
              { accountId: ws.account_id as string, workspaceId },
              {
                domain,
                pageTitle: r.result.pageTitle ?? r.result.pageUrl,
                pageUrl: r.result.pageUrl,
                executionId: r.result.executionId,
                changed: r.result.changed,
                hunks: r.result.hunks,
                checks: r.result.checks,
                factCheck: r.result.factCheck,
              },
            );
            out.rewrite += `, ${describeSendOutcome(sent)}`;
          } catch (err) {
            out.rewrite += `, email failed (${err instanceof Error ? err.message : "unknown"})`;
          }
        } else {
          out.rewrite = `failed: ${r.error}`;
          out.status = "error";
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
    stopped,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
}

/**
 * Every run of this job lands in `system_events` (lib/observability/cron.ts):
 * a throw or a 5xx as an error, per-item failures as a warning, and a clean
 * run as one `info` row — which is the only thing anywhere that proves the
 * schedule is still firing.
 */
export const GET = observedCron("cron.refresh", run);
