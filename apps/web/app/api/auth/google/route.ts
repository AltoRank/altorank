import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getAuthUrl, type GoogleIntegrationId } from "@/lib/google/oauth";
import { encodeOauthState, newOauthNonce, setOauthNonce } from "@/lib/google/oauth-state";

/**
 * Start the Google OAuth flow.
 *
 * The missing half of the connection: `lib/google/oauth.ts`, the callback,
 * token refresh, the GSC/GA4 fetchers and the analytics cron were all written,
 * but nothing ever sent a user to Google. `getAuthUrl` had zero callers, so no
 * workspace could ever obtain tokens and the cron had nothing to fetch for.
 *
 *   GET /api/auth/google?workspaceId=<uuid>&integrationId=gsc|ga4
 *   GET /api/auth/google?integrationId=gsc            (account level)
 *
 * Each integration asks Google for its own scope only (lib/google/oauth.ts):
 * Search Console for `gsc`, Analytics for `ga4`.
 *
 * State is `{workspaceId}:{integrationId}:{nonce}`, with the literal
 * `account` in the workspace slot for an account-level connect. Ownership is verified here
 * as well as in the callback: state travels through the user's browser and
 * comes back attacker-controllable, so the callback cannot trust it, and
 * checking here fails fast with a useful message rather than after a round
 * trip to Google. The nonce is what makes the return trip provably the same
 * browser's - without it a victim could be handed somebody else's `code`.
 */

const SUPPORTED = new Set<GoogleIntegrationId>(["gsc", "ga4"]);

function isSupported(id: string): id is GoogleIntegrationId {
  return SUPPORTED.has(id as GoogleIntegrationId);
}

function back(request: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/connect", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");
  const integrationId = searchParams.get("integrationId");

  // No workspace is a valid request now: connecting at the account level is
  // how someone with no sites yet gets to pick properties and have the
  // workspaces made for them. State carries "account" in the workspace slot.
  if (!integrationId) {
    return back(request, { error: "missing_params" });
  }
  if (!isSupported(integrationId)) {
    return back(request, { error: `unsupported_integration:${integrationId}` });
  }
  // A GA4 property belongs to one site, and the account-level landing page
  // (/connect/google) lists Search Console properties, so Analytics is only
  // ever connected from a site.
  if (!workspaceId && integrationId !== "gsc") {
    return back(request, { error: "choose_a_site_to_connect_google_analytics_for" });
  }

  // Fail before redirecting to Google, so a missing client ID reads as a
  // configuration problem rather than an opaque error on Google's page.
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REDIRECT_URI) {
    return back(request, { error: "google_oauth_not_configured" });
  }

  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return back(request, { error: "unauthorized" });

  // The account that owns the site (lib/auth/require-auth.ts), or for an
  // account-level connect the account the person is working in - the same
  // call the callback makes, so both ends agree on the account. A bare
  // `.single()` on the person's memberships refused anyone in two accounts
  // ("no_account"), and checked the site against whichever membership came
  // back rather than the one that owns it.
  let accountId: string;
  try {
    ({ accountId } = await requireAuth(undefined, workspaceId ? { workspaceId } : {}));
  } catch {
    return back(request, { error: workspaceId ? "workspace_not_found" : "no_account" });
  }

  // No site named: connect at the account level. Every "Connect Search
  // Console" that is not a site's own button reaches this through
  // /connect/google (the onboarding wizard, Settings, the Integrations
  // header), and this used to look the site up anyway, as `id = null`, so
  // every one of them ended in `workspace_not_found` and the callback's
  // account branch was unreachable (broken since 2026-09-02).
  let stateWorkspace = "account";
  if (workspaceId) {
    const { data: workspace } = await supabase
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId)
      .eq("account_id", accountId)
      .single();
    if (!workspace) return back(request, { error: "workspace_not_found" });
    stateWorkspace = workspace.id as string;
  }

  try {
    // The nonce ties the return trip to this browser; see lib/google/oauth-state.ts.
    const nonce = newOauthNonce();
    const redirect = NextResponse.redirect(getAuthUrl(encodeOauthState(stateWorkspace, integrationId, nonce), integrationId));
    return setOauthNonce(redirect, nonce);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return back(request, { error: message });
  }
}
