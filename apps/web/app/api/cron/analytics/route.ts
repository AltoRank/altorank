import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { syncWorkspaceAnalytics, type SyncableIntegration } from "@/lib/google/sync";

/**
 * Daily cron: sync GA4 + GSC metrics for all connected workspaces.
 */
export async function GET(request: Request) {
  const cronSecret = cronSecretFrom(request);
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
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
    .not("tokens", "is", null);

  // A query that failed and a workspace list that is genuinely empty both arrive
  // here as a falsy `data`. Reporting the first as `synced: 0` told the caller
  // the sync had run and found nothing to do, so an unreachable database looked
  // exactly like a quiet day for as long as it stayed down.
  if (integrationsError) {
    return NextResponse.json({ error: integrationsError.message }, { status: 500 });
  }

  if (!integrations?.length) {
    return NextResponse.json({ success: true, synced: 0 });
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];

  const results: Array<{ workspaceId: string; ga4: number; gsc: number; error?: string }> = [];
  for (const integration of integrations) {
    results.push(await syncWorkspaceAnalytics(supabase, integration as SyncableIntegration, dateStr));
  }

  return NextResponse.json({ success: true, synced: results.length, results });
}
