import { NextRequest } from "next/server";
import { json, preflight, clientIp, allowsCredentials } from "@/lib/growth-plan/http";
import { handleToolRequest } from "@/lib/public-tools/handler";
import { viewerFromCookies } from "@/lib/public-tools/viewer";

/**
 * POST /api/public/tools/<slug>  { ...tool input }
 *
 * The free tools on altorank.co; CORS for the marketing origins
 * (lib/growth-plan/http.ts). Each tool is one entry in
 * lib/public-tools/registry.ts; the order of checks (validate, account for
 * paid kinds, cache, per-IP limit, the account's daily runs, spend, run with
 * a deadline) lives in lib/public-tools/handler.ts.
 *
 * Fetch tools are anonymous. The paid kinds (`ai`, `data`) need a signed-in
 * account with a confirmed email: the widget calls with credentials, and the
 * answer carries Access-Control-Allow-Credentials for the marketing origins.
 *
 *   200  { ok: true, data: { blocks }, cached?, remaining? }
 *   4xx  { ok: false, error, code }   invalid_input 400, auth_required 401,
 *                                     email_unverified 403, not_found 404,
 *                                     rate_limited 429, user_cap 429,
 *                                     daily_cap 429
 *   5xx  { ok: false, error, code }   upstream 502, unknown 500
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS = { credentials: true } as const;

export async function OPTIONS(request: NextRequest) {
  return preflight(request.headers.get("origin"), CORS);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const origin = request.headers.get("origin");
  const { slug } = await params;
  const res = await handleToolRequest(slug, () => request.json(), clientIp(request.headers), {
    // The session is read only for a request from an origin allowed to send
    // one (or a same-origin / non-browser call, which carries no Origin). A
    // page on any other site that gets a cookie sent along is not signed in.
    getViewer: () => (origin === null || allowsCredentials(origin) ? viewerFromCookies() : Promise.resolve(null)),
  });
  return json(res.body, res.status, origin, res.headers, CORS);
}
