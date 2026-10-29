// ---------------------------------------------------------------------------
// Whether the person on the gate has been here before
// ---------------------------------------------------------------------------
//
// The onboarding.step events are kept once per site (./step-events.ts), so
// `gate_shown` says when the gate was first shown and nothing after. Owners
// who came back days later were shown the same wall as on their first visit,
// and nothing recorded the return. `gate_visits` (migration 121) keeps
// one row per site per UTC day the gate was shown, written whenever the
// browser says `gate_shown` (app/api/onboard/step), and the gate greets a
// return from it - from a recorded visit, not from the article's age: the
// cron can write the article overnight for someone who has been here before.
//
// Server-only: the table is the service role's alone. Every read and write
// names its workspace, and the caller has already read that workspace
// through the person's own client.

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How long after a visit the next one is a return: a reload, a checkout
 * that came back, a second tab the same evening are not; the next morning is.
 */
export const RETURN_AFTER_MS = 12 * 60 * 60 * 1000;

/** The visit's day, in UTC: one row per site per day. */
export function visitDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whether a visit at `now` is a return, given the latest earlier visit's time (or null). Pure. */
export function isReturnVisit(previous: string | null, now: Date): boolean {
  const at = previous ? Date.parse(previous) : NaN;
  return Number.isFinite(at) && now.getTime() - at >= RETURN_AFTER_MS;
}

/** Record today's visit to the gate, once per site per day. Never throws; `true` when this call wrote it. */
export async function recordGateVisit(db: SupabaseClient, input: { workspaceId: string; accountId: string }, now = new Date()): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("gate_visits")
      .upsert(
        { workspace_id: input.workspaceId, account_id: input.accountId, day: visitDay(now), seen_at: now.toISOString() },
        { onConflict: "workspace_id,day", ignoreDuplicates: true },
      )
      .select("day");
    if (error) {
      console.warn(`[gate_visits] could not record a visit: ${error.message}`);
      return false;
    }
    return (data ?? []).length > 0;
  } catch (err) {
    console.warn(`[gate_visits] ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Whether this site's gate was shown before, long enough ago that today is a
 * return (`RETURN_AFTER_MS`). A failed read, or the table not there yet, is
 * "no": the gate then greets nobody, as it did before.
 */
export async function returningToGate(db: SupabaseClient, workspaceId: string, now = new Date()): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("gate_visits")
      .select("seen_at")
      .eq("workspace_id", workspaceId)
      .lte("seen_at", new Date(now.getTime() - RETURN_AFTER_MS).toISOString())
      .order("seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return false;
    return isReturnVisit((data as { seen_at?: string } | null)?.seen_at ?? null, now);
  } catch {
    return false;
  }
}
