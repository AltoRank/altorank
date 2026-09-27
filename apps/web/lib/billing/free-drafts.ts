// ---------------------------------------------------------------------------
// The free tier's counter, moved once per draft written
// ---------------------------------------------------------------------------
//
// `accounts.free_drafts_used` is what a delete cannot walk back: `getQuota`
// reads the larger of it and the live article count (lib/billing/quota.ts).
// The writer moves it once a no-plan account's draft EXISTS - after its text
// is saved - and never before, or a run Vercel killed at the function limit
// spent a free draft on a row at zero words (2026-09-09). The one exception is
// an account before its trial, whose single draft is claimed as an attempt
// (claimPreTrialDraft in lib/billing/trial-hold.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { accountCountingClient } from "@/lib/billing/account-client";

/**
 * One more draft than the column holds NOW, as a compare-and-set, so two
 * drafts finishing together each add their one.
 *
 * The writer used to record `quota.used + 1`, the count read when the run
 * started. That count is the larger of this column and the live article
 * count, and on the in-place path the live count already holds the textless
 * row being written into (the agent API and "New article" insert it first),
 * so every such draft was counted twice: an account with two drafts that
 * wrote a third was recorded at four, and had three of its seven left instead
 * of four (round-5 review). The column counts drafts written, one each; the
 * live count floors it, which is what covers a write lost here.
 *
 * Service role, whatever client the caller holds (the column is
 * server-written only, migration 099). Best effort, for the same reason.
 */
export async function recordFreeDraftWritten(supabase: SupabaseClient, accountId: string): Promise<void> {
  try {
    const counting = accountCountingClient(supabase);
    // A handful of rounds: each lost round is another draft's increment landing.
    for (let round = 0; round < 3; round++) {
      const { data, error } = await counting.from("accounts").select("free_drafts_used").eq("id", accountId).maybeSingle();
      if (error || !data) return;
      const current = (data.free_drafts_used as number | null) ?? 0;
      const { data: moved, error: moveError } = await counting
        .from("accounts")
        .update({ free_drafts_used: current + 1 })
        .eq("id", accountId)
        .eq("free_drafts_used", current)
        .select("id");
      if (moveError) return;
      if (moved && moved.length > 0) return;
    }
  } catch {
    // The live count still floors it; see getQuota.
  }
}
