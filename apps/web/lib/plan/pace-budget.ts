// ---------------------------------------------------------------------------
// One weekly budget for new articles and improvements
// ---------------------------------------------------------------------------
//
// A site's pace (`auto_generate_weekly_limit`) is sold as one number: articles
// a week. A scheduled improvement - a rewrite of a page that already ranks -
// spends one of those, which the settings copy has always said ("consuming
// one slot of your article pace") and which nothing enforced: cron/generate
// counted only the drafts it wrote, cron/refresh counted nothing, and a site
// at 7 a week with two improvement days could run nine model calls in a week.
//
// This is the one place the arithmetic lives, so both crons read the same
// budget and neither can spend what the other has already used:
//
//   used            drafts written autonomously in the trailing week, plus
//                   rewrites executed in it. A rewrite is not an article row,
//                   so it is counted from `refresh_executions`; nothing is
//                   counted twice.
//   reserved        improvements still scheduled within the coming week that
//                   the refresh cron can actually run - no more than the
//                   site's improvement days, and none if refreshes are off.
//                   Held back from the article side so that a rewrite the
//                   calendar shows on Thursday is not eaten by the 01:00
//                   article run on Tuesday. The calendar is the promise.
//   articlesLeft    limit - used - reserved
//   improvementsLeft limit - used
//
// The window is the trailing seven days, matching how the weekly limit has
// always been counted (lib/content/generate-queue.ts). A calendar week would
// let a site write its whole week on Monday.

import type { SupabaseClient } from "@supabase/supabase-js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PaceBudget {
  limit: number;
  /** Autonomous drafts written in the window. */
  articlesWritten: number;
  /** Rewrites executed in the window. */
  rewritesDone: number;
  used: number;
  /** Improvements held back from the article side. */
  reserved: number;
  articlesLeft: number;
  improvementsLeft: number;
}

/** The arithmetic, separate from the reads so it can be tested. */
export function sharePaceBudget(input: {
  weeklyLimit: number | null | undefined;
  articlesWritten: number;
  rewritesDone: number;
  /** Refresh tasks still `scheduled` for a day within the coming week. */
  tasksPending: number;
  /** How many improvements can run in a week: the enabled days, 0 when refreshes are off. */
  refreshDays: number;
}): PaceBudget {
  const limit = Math.max(0, Math.floor(input.weeklyLimit ?? 0));
  const articlesWritten = Math.max(0, input.articlesWritten);
  const rewritesDone = Math.max(0, input.rewritesDone);
  const used = articlesWritten + rewritesDone;
  const reserved = Math.min(Math.max(0, input.tasksPending), Math.max(0, input.refreshDays));
  return {
    limit,
    articlesWritten,
    rewritesDone,
    used,
    reserved,
    articlesLeft: Math.max(0, limit - used - reserved),
    improvementsLeft: Math.max(0, limit - used),
  };
}

/** "3 of 7 this week (2 articles + 1 improvement)", for a cron's skip reason or a header. */
export function describePaceBudget(b: PaceBudget): string {
  const parts = [`${b.articlesWritten} ${b.articlesWritten === 1 ? "article" : "articles"}`];
  if (b.rewritesDone > 0) parts.push(`${b.rewritesDone} ${b.rewritesDone === 1 ? "improvement" : "improvements"}`);
  const reserved = b.reserved > 0 ? `, ${b.reserved} reserved for ${b.reserved === 1 ? "an improvement" : "improvements"}` : "";
  return `${b.used} of ${b.limit} this week (${parts.join(" + ")}${reserved})`;
}

/**
 * The budget for one workspace, read with the caller's client. Every read is
 * scoped to the workspace: this is the number that stops a run, and a count
 * that leaked a sibling site's drafts would stop the wrong one.
 */
export async function readPaceBudget(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: {
    weeklyLimit: number | null | undefined;
    refreshEnabled: boolean;
    refreshDays: readonly number[] | null | undefined;
    now?: Date;
  },
): Promise<PaceBudget> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const weekAhead = new Date(now.getTime() + 6 * DAY_MS).toISOString().slice(0, 10);

  const [{ count: articles }, { count: rewrites }, { count: pending }] = await Promise.all([
    supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("generated_autonomously", true)
      .gte("created_at", since),
    supabase
      .from("refresh_executions")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("created_at", since),
    supabase
      .from("refresh_tasks")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "scheduled")
      .lte("scheduled_for", weekAhead),
  ]);

  return sharePaceBudget({
    weeklyLimit: opts.weeklyLimit,
    articlesWritten: articles ?? 0,
    rewritesDone: rewrites ?? 0,
    tasksPending: pending ?? 0,
    refreshDays: opts.refreshEnabled ? (opts.refreshDays ?? []).length : 0,
  });
}
