import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { exchangeCode, encryptTokens } from "@/lib/google/oauth";
import { backfillAnalytics } from "@/lib/google/sync";
import { listGSCSites, matchGSCSite } from "@/lib/google/gsc";
import { listGA4Properties, matchGA4Property } from "@/lib/google/ga4";
import { getValidAccessToken } from "@/lib/google/oauth";

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

    // An account-level connect has no workspace to verify yet; the account
    // membership checked above is the whole authorisation.
    if (workspaceId !== "account") {
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
    }

    const tokens = await exchangeCode(code);
    const encrypted = encryptTokens(tokens);

    // One consent per account, stored whichever route was taken, so a later
    // workspace resolves its property without asking the person again.
    await supabase.from("agency_integrations").upsert(
      { agency_id: member.agency_id, provider: "google", tokens: { encrypted }, connected_at: new Date().toISOString() },
      { onConflict: "agency_id,provider" },
    );

    // Account-level connect: there is no workspace to attach to yet, so take
    // the person to the picker, where choosing properties creates them.
    if (workspaceId === "account") {
      return NextResponse.redirect(new URL("/connect/google", request.url));
    }

    // Store encrypted tokens in workspace_integrations
    const { error: dbError } = await supabase
      .from("workspace_integrations")
      .upsert(
        // One consent screen grants Search Console AND GA4 (lib/google/oauth
        // asks for both scopes), so connecting one while the other still read
        // "Not connected" was wrong: the access is there. Both rows come from
        // the same tokens; each resolves its own property on first sync.
        ["gsc", "ga4"].map((id) => ({
          workspace_id: workspaceId,
          integration_id: id,
          config: { type: id },
          tokens: { encrypted },
          connected_at: new Date().toISOString(),
        })),
        { onConflict: "workspace_id,integration_id" },
      );

    // One consent, every site it covers.
    //
    // The connection was stored against the single workspace whose button was
    // pressed, so an account with five sites had to walk the same Google
    // consent five times, and nothing told it which of its properties were
    // already available. Google has just told us what this account can see:
    // match it against every workspace in the account and connect the ones it
    // covers, with the property resolved up front (2026-09-02).
    let alsoConnected = 0;
    try {
      const accessToken = await getValidAccessToken(encrypted, async () => {});
      const [sites, properties] = await Promise.all([
        listGSCSites(accessToken).catch(() => []),
        listGA4Properties(accessToken).catch(() => []),
      ]);
      const { data: siblings } = await supabase
        .from("workspaces")
        .select("id, domain")
        .eq("agency_id", member.agency_id)
        .not("domain", "is", null);

      for (const ws of siblings ?? []) {
        const domain = ws.domain as string;
        const site = matchGSCSite(sites, domain);
        const property = matchGA4Property(properties, domain);
        if (!site && !property) continue;
        const rows: Record<string, unknown>[] = [];
        const connectedAt = new Date().toISOString();
        if (site) rows.push({ workspace_id: ws.id, integration_id: "gsc", config: { type: "gsc", gscSiteUrl: site.siteUrl }, tokens: { encrypted }, connected_at: connectedAt });
        if (property) rows.push({ workspace_id: ws.id, integration_id: "ga4", config: { type: "ga4", ga4PropertyId: property.propertyId }, tokens: { encrypted }, connected_at: connectedAt });
        await supabase.from("workspace_integrations").upsert(rows, { onConflict: "workspace_id,integration_id" });
        if (ws.id !== workspaceId) alsoConnected++;
      }
    } catch (err) {
      console.error("[google] linking sibling workspaces:", err instanceof Error ? err.message : err);
    }

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
      new URL(`/workspaces/${workspaceId}?connected=${encodeURIComponent(integrationId)}&synced=${synced}&also=${alsoConnected}`, request.url),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.redirect(
      new URL(`/connect?error=${encodeURIComponent(message)}`, request.url),
    );
  }
}
