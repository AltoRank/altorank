import { createClient } from "@supabase/supabase-js";
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
 * built directly from the environment, with no workspace attribution. A row
 * with no workspace beats no row; the operation column still says which
 * endpoint, and the timestamp still says when.
 *
 * Built from @supabase/supabase-js rather than @/lib/supabase/server on
 * purpose: that module imports next/headers, and this one is reached from
 * lib/seo/client.ts, which the test suite and the standalone scripts import.
 * When the environment has no Supabase this is a no-op, which is what a
 * script running against the API alone should get.
 */

let client: ReturnType<typeof createClient> | null | undefined;

function serviceClient() {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return client;
}

export function recordSpendByDefault(entry: SpendEntry): void {
  const supabase = serviceClient();
  if (!supabase) return;
  // Fire and forget. recordSpend already swallows its own failures; the
  // `void` is so an unhandled rejection can never surface from here.
  void recordSpend(supabase, entry);
}
