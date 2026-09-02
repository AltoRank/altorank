import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { exchangeCode, encryptTokens } from "@/lib/google/oauth";
import { backfillAnalytics } from "@/lib/google/sync";

/**
 * Google OAuth callback — exchanges code for tokens and saves them.
 * State format: `{workspaceId}:{integrationId}`
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/connect?error=${encodeURIComponent(error)}`, request.url),
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/connect?error=missing_params", request.url),
    );
  }

  const [workspaceId, integrationId] = state.split(":");
  if (!workspaceId || !integrationId) {
    return NextResponse.redirect(
      new URL("/connect?error=invalid_state", request.url),
    );
  }

  try {
    const supabase = await createClient();

    // Auth: verify user is logged in
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.redirect(
        new URL("/connect?error=unauthorized", request.url),
      );
    }

    // Verify workspace belongs to user's agency
    const { data: member } = await supabase
      .from("agency_members")
      .select("agency_id")
      .eq("user_id", user.id)
      .single();

    if (!member) {
      return NextResponse.redirect(
        new URL("/connect?error=no_agency", request.url),
      );
    }

    const { data: wsCheck } = await supabase
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId)
      .eq("agency_id", member.agency_id)
      .single();

    if (!wsCheck) {
      return NextResponse.redirect(
        new URL("/connect?error=workspace_not_found", request.url),
      );
    }

    const tokens = await exchangeCode(code);
    const encrypted = encryptTokens(tokens);

    // Store encrypted tokens in workspace_integrations
    const { error: dbError } = await supabase
      .from("workspace_integrations")
      .upsert(
        {
          workspace_id: workspaceId,
          integration_id: integrationId,
          config: { type: integrationId },
          tokens: { encrypted },
          connected_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,integration_id" },
      );

    if (dbError) throw new Error(dbError.message);

    // Pull the last week now, so the workspace shows numbers on landing
    // instead of "on the next scheduled sync", which meant 04:00 UTC
    // tomorrow. Bounded: seven days, a couple of calls each. A failure here
    // is not fatal; the nightly cron will cover the same days.
    let synced = 0;
    try {
      const r = await backfillAnalytics(supabase, workspaceId, integrationId, 7);
      synced = r.gsc + r.ga4;
    } catch {
      synced = 0;
    }

    return NextResponse.redirect(
      new URL(`/workspaces/${workspaceId}?connected=${encodeURIComponent(integrationId)}&synced=${synced}`, request.url),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.redirect(
      new URL(`/connect?error=${encodeURIComponent(message)}`, request.url),
    );
  }
}
