// Shared by the routes the marketing site calls: altorank.co is static Astro on
// another origin, so these are the only routes in the app that answer
// cross-origin browser requests. Everything else is same-origin or a cron.
//
// Most of them are anonymous. The public tools are the exception: their paid
// kinds read the visitor's session, so the widget calls them with
// `credentials: "include"` and they answer with `credentials: true` below.
// A credentialed answer names the exact origin (never a wildcard or a
// fallback) and adds Access-Control-Allow-Credentials, and only for the two
// production origins - plus the local Astro origins outside production, so the
// round trip can be exercised on a laptop.

import { NextResponse } from "next/server";

/** The marketing site in production. The only origins that may send cookies. */
const PRODUCTION_ORIGINS = new Set(["https://altorank.co", "https://www.altorank.co"]);

/** Astro dev server and a local preview of the built site. */
const LOCAL_ORIGINS = new Set([
  "http://localhost:4321",
  "http://127.0.0.1:4321",
  "http://localhost:4323",
  "http://127.0.0.1:4323",
]);

const ALLOWED_ORIGINS = new Set([...PRODUCTION_ORIGINS, ...LOCAL_ORIGINS]);

/**
 * Whether a credentialed (cookie-carrying) request from this origin is
 * answered as such. Production: altorank.co and www.altorank.co only.
 */
export function allowsCredentials(origin: string | null): boolean {
  if (!origin) return false;
  if (PRODUCTION_ORIGINS.has(origin)) return true;
  return process.env.NODE_ENV !== "production" && LOCAL_ORIGINS.has(origin);
}

export interface CorsOptions {
  /** Answer credentialed requests (see allowsCredentials). */
  credentials?: boolean;
  /** Methods for the preflight. Default "POST, OPTIONS". */
  methods?: string;
}

export function corsHeaders(origin: string | null, opts: CorsOptions = {}): Record<string, string> {
  const credentialed = opts.credentials === true && allowsCredentials(origin);
  const allow = credentialed ? origin! : origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://altorank.co";
  return {
    "Access-Control-Allow-Origin": allow,
    ...(credentialed ? { "Access-Control-Allow-Credentials": "true" } : {}),
    "Access-Control-Allow-Methods": opts.methods ?? "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(
  body: unknown,
  status: number,
  origin: string | null,
  extra: Record<string, string> = {},
  opts: CorsOptions = {},
) {
  return NextResponse.json(body, { status, headers: { ...corsHeaders(origin, opts), ...extra } });
}

export function preflight(origin: string | null, opts: CorsOptions = {}) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin, opts) });
}

export { clientIp } from "@/lib/tools/client-ip";
