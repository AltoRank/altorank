// ---------------------------------------------------------------------------
// The client that counts an account, whoever is asking
// ---------------------------------------------------------------------------
//
// Quota and the site allowance are facts about an *account*: how many articles
// every workspace of the account wrote this month, and how many workspaces
// there are. Both were counted through the caller's own client, on the
// reasoning that RLS "scopes the counts to what that caller can see anyway".
//
// That was true until migration 053 gave a member `workspace_ids` - access to
// some of the account's sites rather than all of them. From then on the counts
// answered a different question for a scoped member, and both gates broke in
// the same direction:
//
//   an editor scoped to site A on an account at 100/100 saw 0/100, and every
//   generation gate reads that number
//   the same editor saw "1 of 3 sites used" on a full plan, and `createWorkspace`
//   re-ran the identical count before allowing a fourth site
//
// Verified on the local stack 2026-09-06: owner "100 / 100 included articles
// used", scoped editor on the same account "0 / 100".
//
// So the counts run with the service role. The caller's membership of
// `accountId` is already established upstream - `requireAuth`, `ownWorkspace`
// or an API key's own account - and this reads only aggregate billing facts
// about that one account; it never widens what the request may see or write.
//
// Without a service role key (a self-hosted install that never set one) the
// caller's client is returned unchanged, which is exactly today's behaviour.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * A client that sees every workspace of the account, for counting one.
 *
 * Falls back to `fallback` when there is no service role key configured.
 */
export function accountCountingClient(fallback: SupabaseClient): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return fallback;
  if (!cached) {
    cached = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cached;
}

/** Test seam: drop the memoised client so a test can change the environment. */
export function resetAccountCountingClient(): void {
  cached = null;
}
