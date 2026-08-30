import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAuthUrl } from "@/lib/google/oauth";

/**
 * Start the Google OAuth flow.
 *
 * The missing half of the connection: `lib/google/oauth.ts`, the callback,
 * token refresh, the GSC/GA4 fetchers and the analytics cron were all written,
 * but nothing ever sent a user to Google. `getAuthUrl` had zero callers, so no
 * workspace could ever obtain tokens and the cron had nothing to fetch for.
 *
 *   GET /api/auth/google?workspaceId=<uuid>&integrationId=gsc|ga4
 *
 * State is `{workspaceId}:{integrationId}`, the format the callback already
 * parses. Ownership is verified here as well as in the callback: state travels
 * through the user's browser and comes back attacker-controllable, so the
 * callback cannot trust it, and checking here fails fast with a useful message
 * rather than after a round trip to Google.
 */

const SUPPORTED = new Set(["gsc", "ga4"]);

function back(request: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/connect", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");
  const integrationId = searchParams.get("integrationId");

  if (!workspaceId || !integrationId) {
    return back(request, { error: "missing_params" });
  }
  if (!SUPPORTED.has(integrationId)) {
    return back(request, { error: `unsupported_integration:${integrationId}` });
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

  const { data: member } = await supabase
    .from("agency_members")
    .select("agency_id")
    .eq("user_id", user.id)
    .single();
  if (!member) return back(request, { error: "no_agency" });

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("agency_id", member.agency_id)
    .single();
  if (!workspace) return back(request, { error: "workspace_not_found" });

  try {
    return NextResponse.redirect(getAuthUrl(`${workspaceId}:${integrationId}`));
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return back(request, { error: message });
  }
}
