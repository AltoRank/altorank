// ---------------------------------------------------------------------------
// The two things the schedule has to say out loud
// ---------------------------------------------------------------------------
//
// Both run from the generate cron, which is the only job that touches every
// agency on every run and therefore the only place either of these can be
// noticed at all.
//
//   a pause about to end   Stripe resumes collection on the date by itself.
//                          A customer who paused for three months and forgot
//                          would learn about it from a charge.
//   nothing being written  the cron records "skipped" in its JSON body and
//                          moves on, so a site whose keyword queue has run dry
//                          simply stops appearing on the calendar. Every reason
//                          here is fixable by the customer in about a minute.
//
// Neither can fail the run: the first is a reminder, the second is about work
// that did not happen.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isoDay } from "@/lib/billing/resume";
import { notifyNothingWritten, notifyPauseEnding, type NothingWrittenReason } from "./lifecycle";
import { describeSendOutcome } from "./send-once";

/** How long before a pause lifts the reminder goes out. */
export const PAUSE_REMINDER_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export type PauseReminderOutcome = { agencyId: string; pausedUntil: string; emailed: string };

/**
 * Remind every account whose pause lifts within the next few days.
 *
 * The window is a range, not a single day, so a cron that misses a run - or a
 * deployment that skips one - does not skip the reminder with it. `sendOnce`
 * is keyed by (agency, pause date), which is what stops four daily runs inside
 * that window from sending four emails.
 */
export async function remindEndingPauses(
  supabase: SupabaseClient,
  today: Date = new Date(),
): Promise<PauseReminderOutcome[]> {
  const out: PauseReminderOutcome[] = [];
  try {
    const from = isoDay(new Date(today.getTime() + DAY_MS));
    const to = isoDay(new Date(today.getTime() + PAUSE_REMINDER_DAYS * DAY_MS));

    const { data, error } = await supabase
      .from("workspaces")
      .select("agency_id, paused_until")
      .eq("status", "paused")
      .not("paused_until", "is", null)
      .gte("paused_until", from)
      .lte("paused_until", to);
    if (error) throw new Error(error.message);

    // One reminder per account, on the earliest date any of its sites carries -
    // which for an account pause is the same date on all of them.
    const earliest = new Map<string, string>();
    for (const row of data ?? []) {
      const agencyId = row.agency_id as string;
      const day = row.paused_until as string;
      if (!earliest.has(agencyId) || day < earliest.get(agencyId)!) earliest.set(agencyId, day);
    }

    for (const [agencyId, pausedUntil] of earliest) {
      const { data: agency } = await supabase.from("agencies").select("name").eq("id", agencyId).maybeSingle();
      const daysLeft = Math.max(
        1,
        Math.round((Date.parse(`${pausedUntil}T00:00:00Z`) - Date.parse(`${isoDay(today)}T00:00:00Z`)) / DAY_MS),
      );
      const sent = await notifyPauseEnding(supabase, agencyId, {
        agencyName: (agency?.name as string | null) ?? null,
        pausedUntil,
        daysLeft,
      });
      out.push({ agencyId, pausedUntil, emailed: describeSendOutcome(sent) });
    }
  } catch (err) {
    console.error(`[pause-reminder] ${err instanceof Error ? err.message : err}`);
  }
  return out;
}

/**
 * The cron's own skip reasons, translated into the one a customer can act on.
 *
 * Returns null for a skip that is not the customer's to fix - out of quota
 * (the billing emails cover that), the run's own article cap, the site not
 * being readable enough to judge keywords. Telling somebody "nothing was
 * written" for a reason they cannot change is a notification, not help.
 */
export function nothingWrittenReason(detail: string): NothingWrittenReason | null {
  if (detail === "weekly limit is 0") return "pace-zero";
  if (detail === "no keywords tracked for this workspace") return "no-keywords";
  if (detail.startsWith("no keyword qualifies")) return "queue-exhausted";
  return null;
}

/**
 * Tell a site's team that nothing is being written for it, and why.
 *
 * At most one a week per site (`sendOnce`, keyed by the ISO week), which is
 * what makes it safe to call from a cron that runs four times a day over the
 * same skipped workspaces.
 */
export async function announceNothingWritten(
  supabase: SupabaseClient,
  scope: { agencyId: string; workspaceId: string; domain: string | null },
  reason: NothingWrittenReason,
  pausedUntil?: string | null,
  now: Date = new Date(),
): Promise<string> {
  try {
    const out = await notifyNothingWritten(
      supabase,
      { agencyId: scope.agencyId, workspaceId: scope.workspaceId },
      { domain: scope.domain, reason, pausedUntil },
      now,
    );
    return describeSendOutcome(out);
  } catch (err) {
    return `email failed (${err instanceof Error ? err.message : "unknown"})`;
  }
}

/**
 * The sites the generate cron never even looks at: opted into automatic
 * drafting and paused.
 *
 * `cron/generate` filters `status = 'paused'` out of its query, which is
 * correct - a paused site must not be written for - but it means the one state
 * where "nothing is being written" is most obviously true is the one state the
 * loop cannot report on.
 */
export async function announcePausedSites(supabase: SupabaseClient, now: Date = new Date()): Promise<string[]> {
  const lines: string[] = [];
  try {
    const { data, error } = await supabase
      .from("workspaces")
      .select("id, domain, agency_id, paused_until")
      .eq("auto_generate", true)
      .eq("status", "paused");
    if (error) throw new Error(error.message);

    for (const ws of data ?? []) {
      const line = await announceNothingWritten(
        supabase,
        {
          agencyId: ws.agency_id as string,
          workspaceId: ws.id as string,
          domain: (ws.domain as string | null) ?? null,
        },
        "paused",
        (ws.paused_until as string | null) ?? null,
        now,
      );
      if (line && line !== "nobody to email") lines.push(`${ws.domain ?? ws.id}: ${line}`);
    }
  } catch (err) {
    console.error(`[nothing-written] paused sweep: ${err instanceof Error ? err.message : err}`);
  }
  return lines;
}
