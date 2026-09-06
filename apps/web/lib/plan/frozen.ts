// ---------------------------------------------------------------------------
// Which planned keywords the account's plan cannot currently pay for
// ---------------------------------------------------------------------------
//
// The calendar used to have no over-limit state. A plan that dropped - a
// cancelled subscription, the free draft used - left every planned keyword
// reading "Planned", although the schedule would refuse to write all but the
// first few. This derives the rest from what the rows already say, so a
// downgrade is recoverable rather than destructive: nothing is deleted, the
// entries beyond the limit go grey with the reason on them, and they come
// back the moment the allowance grows - an upgrade, or the next month.
//
// The allowance is the quota's `remaining` (lib/billing/quota.ts), the number
// of drafts the plan still includes this month, because that is the number
// the generator checks before every scheduled article. Unwritten planned
// entries are taken in scheduled order; the first `remaining` are active and
// the rest are frozen. Writing an active entry moves one keyword out of the
// list and one draft out of the allowance, so the boundary is stable from
// day to day.
//
// Two things deliberately do not freeze:
//
//   unmetered accounts   self-host, operator and the custom tier have
//                        `remaining: null`. There is no limit to be over, and
//                        inventing one for a self-hosted install would be
//                        wrong.
//   improvements         a rewrite spends a slot of the weekly pace
//                        (lib/plan/pace-budget.ts), not the monthly article
//                        quota. It is never over the plan limit.
//
// The pace (`auto_generate_weekly_limit`) is not part of the allowance either.
// A keyword planned beyond this month's pace is not inactive, it is next
// month's; the re-plan in the Articles-plan control is what trims a queue
// when the pace drops. Only the plan limit freezes.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Quota } from "@/lib/billing/quota";

/** What the ordering reads from an unwritten planned entry. */
export type FrozenCandidate = {
  id: string;
  /** `YYYY-MM-DD` */
  scheduled_date: string;
  /** Tie-break within a day; ISO timestamp. */
  created_at: string;
};

/** The slice of a quota the derivation reads. */
export type Allowance = Pick<Quota, "remaining" | "reason" | "limit">;

/**
 * Ids of the entries beyond the allowance, in scheduled order. Empty when the
 * account is unmetered.
 */
export function frozenEntryIds(entries: readonly FrozenCandidate[], quota: Allowance | null): Set<string> {
  if (!quota || quota.remaining === null) return new Set();
  const allowed = Math.max(0, Math.floor(quota.remaining));
  const sorted = [...entries].sort(
    (a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  return new Set(sorted.slice(allowed).map((e) => e.id));
}

/**
 * Why a frozen card is frozen, in the account's terms, with the way out.
 * Only meaningful for a metered quota; unmetered accounts have nothing frozen.
 */
export function frozenReason(quota: Allowance): string {
  if (quota.reason === "no-plan") {
    return (quota.remaining ?? 0) > 0
      ? `Inactive: the free tier includes ${quota.limit} draft before a plan. Choose one on the Billing page to reactivate.`
      : "Inactive: the free draft is used. Choose a plan on the Billing page to reactivate.";
  }
  return `Inactive: this month's ${quota.limit} included articles are spoken for. Upgrade on the Billing page to reactivate, or it thaws next month.`;
}

export type FrozenState = {
  ids: Set<string>;
  /** Null when nothing can freeze (unmetered). */
  reason: string | null;
};

/** The frozen state from rows already read: the derivation the calendar and the crons share. */
export function deriveFrozen(entries: readonly FrozenCandidate[], quota: Allowance | null): FrozenState {
  if (!quota || quota.remaining === null) return { ids: new Set(), reason: null };
  return { ids: frozenEntryIds(entries, quota), reason: frozenReason(quota) };
}

/**
 * Every unwritten planned entry of one workspace, across all months: the
 * ordering runs over the whole plan, not the month on screen. Pass the
 * caller's client so RLS applies.
 */
export async function readUnwrittenEntries(supabase: SupabaseClient, workspaceId: string): Promise<FrozenCandidate[]> {
  const { data, error } = await supabase
    .from("calendar_entries")
    .select("id, scheduled_date, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "queue")
    .is("article_id", null);
  if (error) throw new Error(error.message);
  return (data ?? []) as FrozenCandidate[];
}

/**
 * The frozen entries of one workspace. Pass the quota already computed for
 * this caller: the cron's quota (`getQuota(service, agencyId, null)`) and a
 * signed-in operator's differ on purpose, and this must not reach a different
 * verdict from the gate that writes. Reads nothing for an unmetered account.
 */
export async function readFrozenEntries(
  supabase: SupabaseClient,
  workspaceId: string,
  quota: Allowance | null,
): Promise<FrozenState> {
  if (!quota || quota.remaining === null) return { ids: new Set(), reason: null };
  return deriveFrozen(await readUnwrittenEntries(supabase, workspaceId), quota);
}
