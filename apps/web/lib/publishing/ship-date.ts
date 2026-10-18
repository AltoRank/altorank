import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublishingCadence } from "@/lib/types";
import { cadenceLocalDate, cadenceSlots, shipLabel } from "./cadence";
import { lastSuccessfulPushAt } from "./log";

// ---------------------------------------------------------------------------
// When an approved article ships
// ---------------------------------------------------------------------------
//
// An article that takes a slot (writeApproval in lib/articles/approve.ts, the
// auto-approve rule, Add to queue) is `scheduled` with no `scheduled_at`, and
// cron/publish phase 2 ships one per cadence slot, oldest `created_at` first.
// Its ship date is therefore derived, never stored: the slot whose index is
// the number of queued articles ahead of it. A draft still in review gets the
// same answer, which is the slot Approve would give it.
//
// An estimate in one respect: a date someone picked (phase 1, `scheduled_at`)
// that lands on a slot day uses that day's publish, and is not counted here.

export type ShipSchedule = {
  cadence: Pick<PublishingCadence, "timezone" | "days_of_week" | "publish_time">;
  /** Queued articles (scheduled, no date), oldest first, as phase 2 takes them. */
  queue: Array<{ id: string; created_at: string }>;
  /** The local date the site last published on, or null. */
  lastLocalDate: string | null;
  now: Date;
};

type ShipArticle = { id: string; status: string; created_at: string; scheduled_at?: string | null };

/**
 * The site's schedule, or null when it has no enabled cadence (an approval
 * there stays `approved` and nothing has a slot).
 */
export async function readShipSchedule(db: SupabaseClient, workspaceId: string, now: Date = new Date()): Promise<ShipSchedule | null> {
  const [{ data: cadence }, { data: queue }, lastPushed] = await Promise.all([
    db.from("publishing_cadences").select("enabled, timezone, days_of_week, publish_time").eq("workspace_id", workspaceId).maybeSingle(),
    db
      .from("articles")
      .select("id, created_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "scheduled")
      .is("scheduled_at", null)
      .order("created_at", { ascending: true }),
    // A label, not a publish: an unreadable log reads as "not today" here,
    // where the cron itself fails closed.
    lastSuccessfulPushAt(db, workspaceId).catch(() => null),
  ]);
  if (!cadence?.enabled) return null;
  const c = cadence as PublishingCadence;
  return {
    cadence: { timezone: c.timezone, days_of_week: c.days_of_week ?? [], publish_time: c.publish_time },
    queue: (queue ?? []) as ShipSchedule["queue"],
    lastLocalDate: lastPushed ? cadenceLocalDate(c.timezone, new Date(lastPushed)) : null,
    now,
  };
}

/**
 * When this article ships: its picked date, or its slot in the queue. Null
 * for an article that is neither in review nor scheduled.
 */
export function shipDateFor(schedule: ShipSchedule, article: ShipArticle): Date | null {
  if (article.status === "scheduled" && article.scheduled_at) return new Date(article.scheduled_at);
  if (article.status !== "review" && article.status !== "scheduled") return null;
  const mine = Date.parse(article.created_at);
  const ahead = schedule.queue.filter((q) => q.id !== article.id && Date.parse(q.created_at) < mine).length;
  return cadenceSlots(schedule.cadence, schedule.now, schedule.lastLocalDate, ahead + 1)[ahead] ?? null;
}

/** `shipDateFor`, as the label the editor and the planner print ("Tue 10:00"). */
export function shipLabelFor(schedule: ShipSchedule, article: ShipArticle): string | null {
  const at = shipDateFor(schedule, article);
  return at ? shipLabel(at, schedule.cadence.timezone, schedule.now) : null;
}
