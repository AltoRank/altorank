"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { sendToolResultEmail } from "@/lib/email/resend";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { renderToolResultEmail, TOOL_RESULT_SLUGS } from "@/lib/tools/result-email";

// The subject and body used to arrive from the browser as hidden inputs, so
// this action was an open relay from our verified domain (2026-09-06). The
// browser now sends the tool slug and the result data; the email is rendered
// server-side from a per-tool renderer (lib/tools/result-email.ts) and an
// unknown slug sends nothing.
const captureSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  toolSlug: z.enum(TOOL_RESULT_SLUGS as [string, ...string[]], { message: "Unknown tool" }),
  context: z.record(z.string(), z.unknown()).optional(),
  sendEmail: z.boolean().optional(),
});

export type CaptureState = {
  success: boolean;
  error?: string;
};

// In-memory and per instance (lib/tools/rate-limit.ts): it resets on a cold
// start and is not shared across Vercel instances, the same as the
// password-reset and growth-plan limits. Enough to stop one client looping the
// form; not a substitute for a shared store.
const IP_LIMIT = { count: 10, windowMs: 60 * 60 * 1000 };
const EMAIL_LIMIT = { count: 3, windowMs: 60 * 60 * 1000 };

export async function captureToolLead(
  _prevState: CaptureState,
  formData: FormData,
): Promise<CaptureState> {
  let context: unknown;
  try {
    const raw = formData.get("context");
    context = raw ? JSON.parse(raw as string) : undefined;
  } catch {
    return { success: false, error: "Invalid input" };
  }

  const parsed = captureSchema.safeParse({
    email: formData.get("email"),
    toolSlug: formData.get("toolSlug"),
    context,
    sendEmail: formData.get("sendEmail") === "true",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { toolSlug, sendEmail } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (
    !checkToolRateLimit("tool-lead-ip", ip, IP_LIMIT.count, IP_LIMIT.windowMs) ||
    !checkToolRateLimit("tool-lead-email", email, EMAIL_LIMIT.count, EMAIL_LIMIT.windowMs)
  ) {
    return { success: false, error: "Too many requests. Try again later." };
  }

  // Rendered before anything is saved: a context that is not this tool's
  // result is a bad request, not a lead.
  const rendered = sendEmail ? renderToolResultEmail(toolSlug, parsed.data.context) : null;
  if (sendEmail && !rendered) {
    return { success: false, error: "Invalid input" };
  }

  try {
    const supabase = createServiceClient();

    await supabase.from("tool_leads").insert({
      email,
      tool_slug: toolSlug,
      context: parsed.data.context ?? {},
    });

    if (rendered) {
      await sendToolResultEmail(email, rendered.subject, rendered.html);
    }

    return { success: true };
  } catch (err) {
    console.error("[capture]", err);
    return {
      success: false,
      error: "Something went wrong. Please try again.",
    };
  }
}
