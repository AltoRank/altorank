import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { ACCOUNT_CONSENT_REFUSED, seesEverySite } from "@/lib/google/account-consent";
import {
  exchangeCode,
  encryptTokens,
  getValidAccessToken,
  grantedIntegrations,
  type GoogleIntegrationId,
} from "@/lib/google/oauth";
import { backfillAnalytics } from "@/lib/google/sync";
import { listGSCSites, matchGSCSite } from "@/lib/google/gsc";
import { listGA4Properties, matchGA4Property } from "@/lib/google/ga4";
import { clearOauthNonce, decodeOauthState, nonceMatches, OAUTH_STATE_COOKIE } from "@/lib/google/oauth-state";

/**
 * Google OAuth callback — exchanges code for tokens and saves them.
 * State format: `{workspaceId}:{integrationId}:{nonce}`, with `account` in
 * the workspace slot for an account-level connect.
 *
 * The nonce is checked against the httpOnly cookie /api/auth/google set when
 * this browser started the flow. Without it, `code` and `state` are just query
 * parameters an attacker can put in a link: consent to Google as themselves,
 * keep the code, then get a signed-in customer to load this URL, and their
 * Google tokens land on the customer's account and pull the attacker's Search
 * Console properties into the customer's sites. See lib/google/oauth-state.ts.
 */
type Supabase = Awaited<ReturnType<typeof createClient>>;

/** What to tell someone who unticked the scope they came to connect. */
const NOT_GRANTED: Record<GoogleIntegrationId, string> = {
  gsc: "Google did not grant access to Search Console. Connect again and leave Search Console ticked on Google's screen.",
  ga4: "Google did not grant access to Google Analytics. Connect again and leave Google Analytics ticked on Google's screen.",
};

function isGoogleIntegration(id: string): id is GoogleIntegrationId {
  return id === "gsc" || id === "ga4";
}

/**
 * One consent, every site it covers.
 *
 * Google has just told us what this consent can see: match it against every
 * site in the account and connect the ones it covers, with the property
 * resolved up front (2026-09-02). Only the integrations the token was granted
 * are written, so a Search Console consent does not mark GA4 connected. A
 * failure here is logged, not fatal: the consent itself is already stored.
 */
async function linkAccountWorkspaces(
  supabase: Supabase,
  accountId: string,
  encrypted: string,
  granted: GoogleIntegrationId[],
): Promise<Array<{ id: string; gsc: boolean; ga4: boolean }>> {
  const linked: Array<{ id: string; gsc: boolean; ga4: boolean }> = [];
  try {
    const accessToken = await getValidAccessToken(encrypted, async () => {});
    const [sites, properties] = await Promise.all([
      granted.includes("gsc") ? listGSCSites(accessToken).catch(() => []) : Promise.resolve([]),
      granted.includes("ga4") ? listGA4Properties(accessToken).catch(() => []) : Promise.resolve([]),
    ]);
    const { data: siblings } = await supabase
      .from("workspaces")
      .select("id, domain")
      .eq("account_id", accountId)
      .not("domain", "is", null);

    for (const ws of siblings ?? []) {
      const domain = ws.domain as string;
      const site = matchGSCSite(sites, domain);
      const property = matchGA4Property(properties, domain);
      if (!site && !property) continue;
      const rows: Record<string, unknown>[] = [];
      const connectedAt = new Date().toISOString();
      const fresh = { tokens: { encrypted }, connected_at: connectedAt, needs_reconnect: false, last_sync_error: null };
      if (site) rows.push({ workspace_id: ws.id, integration_id: "gsc", config: { type: "gsc", gscSiteUrl: site.siteUrl }, ...fresh });
      if (property) rows.push({ workspace_id: ws.id, integration_id: "ga4", config: { type: "ga4", ga4PropertyId: property.propertyId }, ...fresh });
      await supabase.from("workspace_integrations").upsert(rows, { onConflict: "workspace_id,integration_id" });
      linked.push({ id: ws.id as string, gsc: Boolean(site), ga4: Boolean(property) });
    }
  } catch (err) {
    console.error("[google] linking sibling workspaces:", err instanceof Error ? err.message : err);
  }
  return linked;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // One round trip, one nonce, whichever way this ends.
  return clearOauthNonce(await handleCallback(request));
}

async function handleCallback(request: NextRequest): Promise<NextResponse> {
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

  const parsed = decodeOauthState(state);
  if (!parsed || !nonceMatches(parsed.nonce, request.cookies.get(OAUTH_STATE_COOKIE)?.value)) {
    return NextResponse.redirect(
      new URL("/connect?error=invalid_state", request.url),
    );
  }
  const { workspaceId, integrationId } = parsed;
  if (!isGoogleIntegration(integrationId)) {
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

    // The account the consent is for: the one that owns the site, or for an
    // account-level connect the one the person is working in
    // (lib/auth/require-auth.ts) - the same account the property picker then
    // reads the consent back from. A bare `.single()` on the person's
    // memberships refused anyone in two accounts, and stored the consent on
    // whichever membership came back.
    let member: { account_id: string };
    try {
      const { accountId } = await requireAuth(undefined, workspaceId === "account" ? {} : { workspaceId });
      member = { account_id: accountId };
    } catch {
      return NextResponse.redirect(
        new URL(workspaceId === "account" ? "/connect?error=no_account" : "/connect?error=workspace_not_found", request.url),
      );
    }

    // An account-level connect has no workspace to verify yet; the account
    // membership checked above is the whole authorisation.
    if (workspaceId !== "account") {
      const { data: wsCheck } = await supabase
        .from("workspaces")
        .select("id")
        .eq("id", workspaceId)
        .eq("account_id", member.account_id)
        .single();

      if (!wsCheck) {
        return NextResponse.redirect(
          new URL("/connect?error=workspace_not_found", request.url),
        );
      }
    }

    // Whether this person may set the consent the whole account is listed
    // with (lib/google/account-consent.ts). An account-level connect is
    // nothing else, so a member scoped to some sites is refused before the
    // code is spent; a site's own button still connects their site.
    const accountWide = await seesEverySite(supabase, user.id, member.account_id);
    if (workspaceId === "account" && !accountWide) {
      return NextResponse.redirect(
        new URL(`/connect?error=${encodeURIComponent(ACCOUNT_CONSENT_REFUSED)}`, request.url),
      );
    }

    const tokens = await exchangeCode(code);
    const encrypted = encryptTokens(tokens);

    // What this consent can actually read. Each connect asks for its own
    // scope, the token also carries any scope granted before
    // (include_granted_scopes), and Google lets the person untick a scope on
    // its screen - so the answer is the token's, not the button's.
    const granted = grantedIntegrations(tokens.scope);
    if (!granted.includes(integrationId)) {
      return NextResponse.redirect(
        new URL(`/connect?error=${encodeURIComponent(NOT_GRANTED[integrationId])}`, request.url),
      );
    }

    // One consent per account, stored whichever route was taken, so a later
    // workspace resolves its property without asking the person again. Only
    // a consent that reads Search Console: the account's consent is what
    // /connect/google lists properties with, and an Analytics-only token
    // there would empty the list.
    //
    // With the service role: members may only read this table (migration
    // 033), and this upsert ran on the person's own client with its result
    // ignored, so RLS refused it without a word and an account-level connect
    // landed on "No Google account is connected yet", whose link started the
    // same consent again. `accountWide` above is the check that policy would
    // have made. A refusal is now an error: for an account-level connect the
    // consent is the whole point, so it says so; for a site's own button the
    // site's row below is what was asked for, so it is logged and the
    // connect goes on.
    if (granted.includes("gsc") && accountWide) {
      const { error: consentError } = await createServiceClient()
        .from("account_integrations")
        .upsert(
          { account_id: member.account_id, provider: "google", tokens: { encrypted }, connected_at: new Date().toISOString() },
          { onConflict: "account_id,provider" },
        );
      if (consentError) {
        if (workspaceId === "account") {
          throw new Error(`Google connected, but the connection could not be saved: ${consentError.message}`);
        }
        console.error("[google] storing the account consent:", consentError.message);
      }
    }

    // Account-level connect: take the person to the picker, where choosing
    // properties creates workspaces. The sites the account already has are
    // connected first - the onboarding wizard connects from here while its
    // site already exists, so without this the site being set up waited for
    // someone to find its Connect on the picker. One new site gets its last
    // week now, as a site's own button does; more than that waits for the
    // nightly sync, so the redirect does not wait on every site in the account.
    if (workspaceId === "account") {
      const linked = await linkAccountWorkspaces(supabase, member.account_id, encrypted, granted);
      const withGsc = linked.filter((l) => l.gsc);
      if (withGsc.length === 1) {
        try {
          await backfillAnalytics(supabase, withGsc[0].id, "gsc", 7);
        } catch {
          // The nightly sync covers the same days.
        }
      }
      return NextResponse.redirect(new URL("/connect/google", request.url));
    }

    // Store encrypted tokens in workspace_integrations
    const { error: dbError } = await supabase
      .from("workspace_integrations")
      .upsert(
        // A row for every integration this token was granted, not for the
        // button alone: connecting GA4 after Search Console yields a token
        // good for both, and both rows are refreshed from it. A Search
        // Console consent no longer writes a GA4 row it cannot read, so GA4
        // keeps saying "Not connected" and offers its own Connect. Each row
        // resolves its own property on first sync.
        granted.map((id) => ({
          workspace_id: workspaceId,
          integration_id: id,
          config: { type: id },
          tokens: { encrypted },
          connected_at: new Date().toISOString(),
          // Fresh consent, fresh token: a row the nightly sync had marked
          // dead (migration 070) is live again.
          needs_reconnect: false,
          last_sync_error: null,
        })),
        { onConflict: "workspace_id,integration_id" },
      );

    // The connection used to be stored against the single workspace whose
    // button was pressed, so an account with five sites had to walk the same
    // Google consent five times, and nothing told it which of its properties
    // were already available.
    const linked = await linkAccountWorkspaces(supabase, member.account_id, encrypted, granted);
    const alsoConnected = linked.filter((l) => l.id !== workspaceId).length;

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
