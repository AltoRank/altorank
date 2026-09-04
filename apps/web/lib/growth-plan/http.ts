// Shared by the two growth-plan routes: the marketing site is static Astro on
// another origin, so these are the only routes in the app that answer
// cross-origin browser requests. Everything else is same-origin or a cron.

import { NextResponse } from "next/server";

const ALLOWED_ORIGINS = new Set([
  "https://altorank.co",
  "https://www.altorank.co",
  // Astro dev server and a local preview of the built site.
  "http://localhost:4321",
  "http://127.0.0.1:4321",
  "http://localhost:4323",
  "http://127.0.0.1:4323",
]);

export function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://altorank.co";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(body: unknown, status: number, origin: string | null) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

export function preflight(origin: string | null) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
