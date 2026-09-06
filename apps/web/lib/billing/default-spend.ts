import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { recordSpend, type SpendEntry } from "./spend";

/**
 * Spend recording that needs nobody to remember it.
 *
 * lib/seo/client.ts has had a spend hook since 2026-08-30, and three routes
 * arm it: generate, cron/analyze, cron/serp. Everything else - onboarding's
 * first look, every re-discovery, the AI probes, the MCP server, scripts -
 * never did, and the Operations page reported $0 for the provider that runs
 * discovery and rank tracking. Nine discovery runs on 2026-09-02 cost about
 * a dollar and left no row.
 *
 * So this is the fallback when no reporter is armed: a service-role client
 * built directly from the environment. Unattributed unless the caller says
 * otherwise - a row with no workspace beats no row; the operation column still
 * says which endpoint, and the timestamp still says when. A caller that does
 * know the workspace passes it (onboarding does), and the row carries it.
 *
 * The same client is what `spendClient()` hands out. provider_spend has a
 * SELECT policy and nothing else (025, 053), so an insert through a user's
 * session client is refused by RLS - and recordSpend swallows that, by design,
 * so the row simply never appears. Every draft written from a signed-in
 * request (onboarding's first draft, the "New article" modal) lost its
 * Anthropic row that way until 2026-09-05. Bookkeeping is the operator's, not
 * the tenant's, and is written with the operator's key.
 *
 * Built from @supabase/supabase-js rather than @/lib/supabase/server on
 * purpose: that module imports next/headers, and this one is reached from
 * lib/seo/client.ts, which the test suite and the standalone scripts import.
 * When the environment has no Supabase this is a no-op, which is what a
 * script running against the API alone should get.
 */

let client: SupabaseClient | null | undefined;

/**
 * The service-role client spend is written with, or null when the environment
 * has no Supabase (scripts, the test suite). Callers that hold a user-session
 * client must record spend through this one, not theirs; see above.
 */
export function spendClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return client;
}

export function recordSpendByDefault(entry: SpendEntry): void {
  const supabase = spendClient();
  if (!supabase) return;
  // Fire and forget. recordSpend already swallows its own failures; the
  // `void` is so an unhandled rejection can never surface from here.
  void recordSpend(supabase, entry);
}
