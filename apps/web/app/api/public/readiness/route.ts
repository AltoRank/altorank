import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { json, preflight, clientIp } from "@/lib/growth-plan/http";
import { parsePublicDomain } from "@/lib/public-check/domain";
import { AGENT_GUIDANCE, type PublicCheckData } from "@/lib/public-check/shape";
import { loadCachedCheck, runPublicCheck, storeCheck } from "@/lib/public-check/run";
import { renderCheckEmail, checkEmailSubject } from "@/lib/public-check/email";
import { sendToolResultEmail } from "@/lib/email/resend";

/**
 * POST /api/public/readiness  { domain, email?, force? }
 *
 * The free check: can an AI agent read this site? Public and unauthenticated,
 * because a visitor who has to sign up to learn that has not been told
 * anything. It answers from altorank.co (cross-origin, see http.ts), from the
 * share page at /check/<domain>, and to anyone with curl.
 *
 * Three things bound it:
 *
 *   1. A cache by domain, six hours. A shared link is opened many times; the
 *      site it describes should be fetched once. Served before the rate
 *      limit, so a cached answer costs nobody anything.
 *   2. A per-IP limit on fresh runs. In memory, so it resets on deploy and is
 *      per instance on Vercel; good enough to stop a loop, not a determined
 *      abuser. `force` (the Re-run button) counts against it too.
 *   3. A 25s deadline. Checks that did not run come back `unknown`, never
 *      failed, and a partial result is not cached.
 *
 * `email` is optional and never needed to see the result. When given, the
 * address goes to tool_leads with the domain as context, and the result is
 * emailed if the mail provider is configured. The response says which of
 * those happened.
 */
export const maxDuration = 60;

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const bodySchema = z.object({
  domain: z.unknown(),
  email: z.string().email("Please enter a valid email address").optional(),
  force: z.boolean().optional(),
});

export async function OPTIONS(request: NextRequest) {
  return preflight(request.headers.get("origin"));
}

/** Cached result only. Never crawls: the badge and social scrapers use this. */
export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const parsed = parsePublicDomain(request.nextUrl.searchParams.get("domain"));
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400, origin);

  const cached = await loadCachedCheck(createServiceClient(), parsed.domain);
  if (!cached) {
    return json({ ok: false, error: "This domain has not been checked in the last six hours.", agent_guidance: AGENT_GUIDANCE }, 404, origin);
  }
  return json({ ok: true, data: cached, cached: true, agent_guidance: AGENT_GUIDANCE }, 200, origin);
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");

  let body: z.infer<typeof bodySchema>;
  try {
    const result = bodySchema.safeParse(await request.json());
    if (!result.success) {
      return json({ ok: false, error: result.error.issues[0]?.message ?? "Invalid input" }, 400, origin);
    }
    body = result.data;
  } catch {
    return json({ ok: false, error: 'Send JSON: { "domain": "example.com" }' }, 400, origin);
  }

  const parsed = parsePublicDomain(body.domain);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400, origin);
  const { domain } = parsed;

  const supabase = createServiceClient();
  const ip = clientIp(request.headers);

  let data: PublicCheckData | null = body.force ? null : await loadCachedCheck(supabase, domain);
  let cached = data !== null;

  if (!data) {
    if (!checkToolRateLimit("public-readiness", ip, RATE_LIMIT, RATE_WINDOW_MS)) {
      return json(
        { ok: false, error: `That is ${RATE_LIMIT} checks in an hour from this connection. Try again later.` },
        429,
        origin,
      );
    }
    try {
      data = await runPublicCheck(domain);
    } catch (err) {
      console.error("[public-readiness]", domain, err);
      return json({ ok: false, error: "Could not check that domain right now." }, 502, origin);
    }
    cached = false;
    await storeCheck(supabase, data);
  }

  let lead: { saved: boolean; emailed: boolean } | undefined;
  if (body.email) {
    lead = await saveLead(supabase, body.email, data, ip);
  }

  return json({ ok: true, data, cached, ...(lead ? { lead } : {}), agent_guidance: AGENT_GUIDANCE }, 200, origin);
}

async function saveLead(
  supabase: ReturnType<typeof createServiceClient>,
  email: string,
  data: PublicCheckData,
  ip: string,
): Promise<{ saved: boolean; emailed: boolean }> {
  if (!checkToolRateLimit("public-readiness-lead", ip, RATE_LIMIT, RATE_WINDOW_MS)) {
    return { saved: false, emailed: false };
  }
  const { error } = await supabase.from("tool_leads").insert({
    email,
    tool_slug: "readiness-check",
    context: { domain: data.domain, score: data.score, passed: data.passed, known: data.known },
  });
  if (error) {
    console.error("[public-readiness/lead]", error.message);
    return { saved: false, emailed: false };
  }
  try {
    await sendToolResultEmail(email, checkEmailSubject(data), renderCheckEmail(data));
    return { saved: true, emailed: true };
  } catch (err) {
    // The lead is saved either way; the email is the part that can fail.
    console.error("[public-readiness/lead] email", err instanceof Error ? err.message : err);
    return { saved: true, emailed: false };
  }
}
