import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { normalizeDomain, DOMAIN_PATTERN, type GrowthPlan } from "@/lib/growth-plan/build";
import { renderGrowthPlanEmail, growthPlanSubject } from "@/lib/growth-plan/email";
import { json, preflight, clientIp } from "@/lib/growth-plan/http";
import { sendToolResultEmail } from "@/lib/email/resend";

const SIGNUP_URL = "https://app.altorank.co/signup";

/**
 * POST /api/growth-plan/lead  { email, domain }
 *
 * The "email me the full plan" form under the results. Writes to the same
 * `tool_leads` table the free-tool guides use, with the domain as context, so
 * one query answers "who asked for a plan and for which site". Then sends the
 * plan, if the cache still has it and Resend is configured. The response says
 * which happened, and the page words its confirmation from that: "sent" only
 * when something was sent. A promise the code cannot keep is the class of
 * claim this site does not make.
 */
const schema = z.object({
  email: z.string().email("Please enter a valid email address"),
  domain: z.string().min(3),
});

export async function OPTIONS(request: NextRequest) {
  return preflight(request.headers.get("origin"));
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!checkToolRateLimit("growth-plan-lead", clientIp(request.headers), 10, 60 * 60 * 1000)) {
    return json({ error: "Too many requests. Try again later." }, 429, origin);
  }

  let parsed;
  try {
    parsed = schema.safeParse(await request.json());
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }
  if (!parsed.success) {
    return json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400, origin);
  }

  const domain = normalizeDomain(parsed.data.domain);
  if (!DOMAIN_PATTERN.test(domain)) {
    return json({ error: "Invalid domain" }, 400, origin);
  }

  const supabase = createServiceClient();
  const { error } = await supabase.from("tool_leads").insert({
    email: parsed.data.email,
    tool_slug: "growth-plan",
    context: { domain },
  });
  if (error) {
    console.error("[growth-plan/lead]", error.message);
    return json({ error: "Could not save that. Try again." }, 500, origin);
  }

  let emailed = false;
  const { data: cached } = await supabase.from("growth_plans").select("plan").eq("domain", domain).maybeSingle();
  if (cached?.plan) {
    try {
      const plan = cached.plan as GrowthPlan;
      await sendToolResultEmail(parsed.data.email, growthPlanSubject(plan), renderGrowthPlanEmail(plan, SIGNUP_URL));
      emailed = true;
    } catch (err) {
      // Lead is saved either way; the email is the part that can fail.
      console.error("[growth-plan/lead] email", err instanceof Error ? err.message : err);
    }
  }
  return json({ ok: true, emailed }, 200, origin);
}
