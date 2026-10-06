import { NextRequest } from "next/server";
import { json, preflight, allowsCredentials } from "@/lib/growth-plan/http";
import { viewerFromCookies } from "@/lib/public-tools/viewer";
import { runsLeftToday, userDailyRuns } from "@/lib/public-tools/user-runs";

/**
 * GET /api/public/tools/me  (credentials)
 *
 * What the tool widget on altorank.co needs to show before anyone types:
 *
 *   { signedIn: false }
 *   { signedIn: true, verified: false }
 *   { signedIn: true, verified: true, remaining: number | null, limit: number }
 *
 * `remaining` is null when the count could not be read. Nothing else about
 * the account is answered: no email, no id, no name.
 */
export const dynamic = "force-dynamic";

const CORS = { credentials: true, methods: "GET, OPTIONS" } as const;
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function OPTIONS(request: NextRequest) {
  return preflight(request.headers.get("origin"), CORS);
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const viewer = origin === null || allowsCredentials(origin) ? await viewerFromCookies() : null;
  if (!viewer) return json({ signedIn: false }, 200, origin, NO_STORE, CORS);
  if (!viewer.verified) return json({ signedIn: true, verified: false }, 200, origin, NO_STORE, CORS);
  const remaining = await runsLeftToday(viewer.id);
  return json({ signedIn: true, verified: true, remaining, limit: userDailyRuns() }, 200, origin, NO_STORE, CORS);
}
