// ---------------------------------------------------------------------------
// Pausing and resuming one site
// ---------------------------------------------------------------------------
//
// The behaviour behind the Pause/Resume buttons (app/actions/workspaces.ts)
// and the agent API's POST /workspaces/{id}/pause and /resume, on a plain
// SupabaseClient so both doors run the same code. Every write names the
// agency as well as the id: the agent API holds a service-role client with no
// RLS behind it, and the cookie client's id arrives from the browser.
//
// Pausing touches nothing but status and paused_meta. Drafts stay in review,
// planned entries stay on their days, the pace stays set: it is "not now", and
// the generate, analyze, site-pages and publish crons all skip
// `status = 'paused'` (lib/plan/__tests__/cron-pause-guard.test.ts). Distinct
// from the account-wide pause on Billing, which sets `paused_until`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { FREE_TIER_PACE } from "@/lib/content/pace";
import { schedulePlan } from "@/lib/onboarding/plan";
import type { PausedMeta } from "@/lib/types";

export type PauseOutcome = {
  /** False when the site was already paused and nothing changed. */
  changed: boolean;
  meta: PausedMeta;
};

export async function pauseWorkspace(
  supabase: SupabaseClient,
  agencyId: string,
  workspaceId: string,
  /** The user who asked, or null when an API key did. */
  by: string | null,
): Promise<PauseOutcome> {
  const { data: ws, error: readError } = await supabase
    .from("workspaces")
    .select("id, status, paused_meta")
    .eq("id", workspaceId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!ws) throw new Error("That site is not in your account.");
  if (ws.status === "paused") return { changed: false, meta: ws.paused_meta as PausedMeta };

  const meta: PausedMeta = {
    since: new Date().toISOString(),
    previous_status: (ws.status as PausedMeta["previous_status"]) ?? "on",
    by,
  };
  const { error } = await supabase
    .from("workspaces")
    .update({ status: "paused", paused_meta: meta })
    .eq("id", workspaceId)
    .eq("agency_id", agencyId);
  if (error) throw new Error(error.message);
  return { changed: true, meta };
}

export type ResumeOutcome = {
  /** False when the site was not paused and nothing changed. */
  changed: boolean;
  status: string;
  /** Entries re-planned from today, or null when the re-plan failed or did not run. */
  replanned: number | null;
};

/**
 * Put back the status the site had, then re-plan the calendar from today: the
 * planned days it missed while paused are in the past, and a plan that
 * promises yesterday is not a plan. Nothing written is touched - `schedulePlan`
 * replaces only queued entries with no article.
 *
 * The re-plan is reported rather than allowed to fail the resume. The status
 * is the thing that matters and is already written.
 */
export async function resumeWorkspace(
  supabase: SupabaseClient,
  agencyId: string,
  workspaceId: string,
): Promise<ResumeOutcome> {
  const { data: ws, error: readError } = await supabase
    .from("workspaces")
    .select("id, status, paused_meta, auto_generate_weekly_limit")
    .eq("id", workspaceId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!ws) throw new Error("That site is not in your account.");
  if (ws.status !== "paused") return { changed: false, status: ws.status as string, replanned: null };

  const meta = (ws.paused_meta ?? null) as PausedMeta | null;
  const previous: PausedMeta["previous_status"] =
    meta?.previous_status === "review" || meta?.previous_status === "setup" ? meta.previous_status : "on";

  const { error } = await supabase
    .from("workspaces")
    .update({ status: previous, paused_meta: null })
    .eq("id", workspaceId)
    .eq("agency_id", agencyId);
  if (error) throw new Error(error.message);

  let replanned: number | null = null;
  try {
    const { data: cadence } = await supabase
      .from("publishing_cadences")
      .select("days_of_week, enabled")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const days = cadence?.enabled ? (cadence.days_of_week as number[]) : undefined;
    const plan = await schedulePlan(supabase, workspaceId, (ws.auto_generate_weekly_limit as number | null) ?? FREE_TIER_PACE, {
      daysOfWeek: days,
    });
    replanned = plan.length;
  } catch {
    replanned = null;
  }
  return { changed: true, status: previous, replanned };
}
