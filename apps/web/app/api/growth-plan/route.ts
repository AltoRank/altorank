import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { buildGrowthPlan, normalizeDomain, DOMAIN_PATTERN, type GrowthPlan } from "@/lib/growth-plan/build";
import { json, preflight, clientIp } from "@/lib/growth-plan/http";

/**
 * POST /api/growth-plan  { domain }  ->  GrowthPlan
 *
 * Public and unauthenticated on purpose: it is the homepage hook, and a visitor
 * who has to sign up to see their plan has not been hooked. Three things keep
 * it from being an open tap on the DataForSEO account:
 *
 *   1. Per-IP limit, in memory (resets on deploy, fine for a hook).
 *   2. A cache by domain: the same site asked twice in a day costs once.
 *   3. A daily ceiling on fresh plans across all callers, so a bad day is a
 *      known number rather than a surprise on the invoice.
 *
 * Four DataForSEO calls at most (ranked x3, competitors x1) plus the
 * no-cost readiness checks. Runs in ~3s live; maxDuration is the Hobby cap.
 */
export const maxDuration = 60;

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DAILY_FRESH_PLANS = 300;

export async function OPTIONS(request: NextRequest) {
  return preflight(request.headers.get("origin"));
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");

  let raw = "";
  try {
    const body = (await request.json()) as { domain?: unknown };
    raw = typeof body.domain === "string" ? body.domain : "";
  } catch {
    return json({ error: "Send JSON: { \"domain\": \"example.com\" }" }, 400, origin);
  }

  const domain = normalizeDomain(raw);
  if (!DOMAIN_PATTERN.test(domain)) {
    return json({ error: "That does not look like a domain. Try example.com." }, 400, origin);
  }

  const supabase = createServiceClient();

  // Cache first, before the rate limit: a cached answer costs nothing, so it
  // should not count against anyone.
  const { data: cached } = await supabase
    .from("growth_plans")
    .select("plan, created_at")
    .eq("domain", domain)
    .maybeSingle();
  if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_TTL_MS) {
    return json({ ...(cached.plan as GrowthPlan), cached: true }, 200, origin);
  }

  if (!checkToolRateLimit("growth-plan", clientIp(request.headers), RATE_LIMIT, RATE_WINDOW_MS)) {
    return json({ error: `That is ${RATE_LIMIT} plans in an hour from this connection. Try again later.` }, 429, origin);
  }

  const { count } = await supabase
    .from("growth_plans")
    .select("domain", { count: "exact", head: true })
    .gte("created_at", new Date(Date.now() - CACHE_TTL_MS).toISOString());
  if ((count ?? 0) >= DAILY_FRESH_PLANS) {
    return json({ error: "The free check has hit today's limit. Try again tomorrow." }, 503, origin);
  }

  let plan: GrowthPlan;
  try {
    plan = await buildGrowthPlan(domain);
  } catch (err) {
    console.error("[growth-plan]", domain, err);
    return json({ error: "Could not build a plan for that domain right now." }, 502, origin);
  }

  // Cache even a partial plan: a site that blocks us today blocks us in an
  // hour too, and retrying costs the same.
  await supabase.from("growth_plans").upsert({ domain, plan, created_at: new Date().toISOString() });

  return json(plan, 200, origin);
}
