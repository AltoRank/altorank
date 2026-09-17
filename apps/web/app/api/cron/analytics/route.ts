import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { syncWorkspaceAnalytics, syncDates, type SyncableIntegration } from "@/lib/google/sync";
import { syncBingWorkspace, type BingIntegration, type BingSyncResult } from "@/lib/bing/sync";
import { observedCron } from "@/lib/observability/cron";

/**
 * Daily cron: sync GA4 + GSC metrics for the last SYNC_LAG_DAYS days for all
 * connected workspaces, then Bing.
 */
async function run(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
 * Cron requests carry no cookies, so the cookie-bound client authenticates as
 * nobody and RLS answers every query with an empty set. That is not an error,
 * so this route reported `success` with a zero count and had never processed a
 * single row. A cron has no user by definition: it must hold the service role.
 */
  const supabase = createServiceClient();

  // One row per workspace, not one per integration.
  //
  // Connecting writes a gsc row and a ga4 row from the same consent, and this
  // loop ran the whole sync once for each: two identical passes per workspace,
  // and whichever ran last wrote its resolved Search Console property into the
  // GA4 row's config (2026-09-02). The sync handles both services from one
  // row, so it takes the gsc one.
  const { data: integrations, error: integrationsError } = await supabase
    .from("workspace_integrations")
    .select("*, workspace:workspaces(id, domain)")
    .eq("integration_id", "gsc")
    .not("tokens", "is", null)
    // A connection Google has refused (migration 070) waits for the person to
    // reconnect; retrying it nightly would only log the same refusal.
    .eq("needs_reconnect", false);

  // A query that failed and a workspace list that is genuinely empty both arrive
  // here as a falsy `data`. Reporting the first as `synced: 0` told the caller
  // the sync had run and found nothing to do, so an unreachable database looked
  // exactly like a quiet day for as long as it stayed down.
  if (integrationsError) {
    return NextResponse.json({ error: integrationsError.message }, { status: 500 });
  }

  // Not just yesterday: Search Console has not published yesterday yet when
  // this runs, and a day asked for once and never again is a day lost. See
  // SYNC_LAG_DAYS for what that did to production.
  const dates = syncDates();

  const results: Array<{ workspaceId: string; ga4: number; gsc: number; error?: string; needsReconnect?: boolean }> = [];
  for (const integration of integrations ?? []) {
    for (const dateStr of dates) {
      results.push(await syncWorkspaceAnalytics(supabase, integration as SyncableIntegration, dateStr));
    }
  }

  // Bing: the last week, replaced in place, because Bing revises recent days.
  // One call per workspace returns the whole series, so this is cheap.
  const { data: bingRows, error: bingError } = await supabase
    .from("workspace_integrations")
    .select("*, workspace:workspaces(id, domain)")
    .eq("integration_id", "bing")
    .not("tokens", "is", null);
  if (bingError) {
    return NextResponse.json({ error: bingError.message }, { status: 500 });
  }
  const bing: BingSyncResult[] = [];
  for (const row of bingRows ?? []) {
    bing.push(await syncBingWorkspace(supabase, row as BingIntegration, 7));
  }

  return NextResponse.json({ success: true, synced: results.length + bing.length, results, bing });
}

/**
 * Every run of this job lands in `system_events` (lib/observability/cron.ts):
 * a throw or a 5xx as an error, per-item failures as a warning, and a clean
 * run as one `info` row — which is the only thing anywhere that proves the
 * schedule is still firing.
 */
export const GET = observedCron("cron.analytics", run);
