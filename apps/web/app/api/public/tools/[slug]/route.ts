import { NextRequest } from "next/server";
import { json, preflight, clientIp } from "@/lib/growth-plan/http";
import { handleToolRequest } from "@/lib/public-tools/handler";

/**
 * POST /api/public/tools/<slug>  { ...tool input }
 *
 * The free tools on altorank.co. Public and unauthenticated; CORS for the
 * marketing origins (lib/growth-plan/http.ts). Each tool is one entry in
 * lib/public-tools/registry.ts; the order of checks (validate, cache,
 * per-IP limit, spend, run with a deadline) lives in lib/public-tools/handler.ts.
 *
 *   200  { ok: true, data: { blocks }, cached? }
 *   4xx  { ok: false, error, code }   invalid_input 400, not_found 404,
 *                                     rate_limited 429, daily_cap 429
 *   5xx  { ok: false, error, code }   upstream 502, unknown 500
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function OPTIONS(request: NextRequest) {
  return preflight(request.headers.get("origin"));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const origin = request.headers.get("origin");
  const { slug } = await params;
  const res = await handleToolRequest(slug, () => request.json(), clientIp(request.headers));
  return json(res.body, res.status, origin, res.headers);
}
