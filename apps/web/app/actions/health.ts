"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { getToolBySlug } from "@/lib/tools/registry";
import { generateHealthCheck } from "@/lib/tools/generate-health";
import type { HealthCheckResult } from "@/lib/tools/types";

const TOOL = getToolBySlug("seo-health-checker")!;

const healthSchema = z.object({
  url: z.string().url("Please enter a valid URL"),
});

export type HealthActionState = {
  success: boolean;
  result?: HealthCheckResult;
  error?: string;
};

export async function checkHealthAction(
  _prevState: HealthActionState,
  formData: FormData,
): Promise<HealthActionState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  if (!checkToolRateLimit(TOOL.slug, ip, TOOL.rateLimit, TOOL.rateWindowMs)) {
    return {
      success: false,
      error: `Rate limit reached — ${TOOL.rateLimit} checks per hour. Try again later.`,
    };
  }

  const parsed = healthSchema.safeParse({
    url: formData.get("url"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  try {
    const result = await generateHealthCheck(parsed.data.url);
    return { success: true, result };
  } catch (err) {
    console.error("[health-action]", err);
    const message =
      err instanceof Error ? err.message : "Something went wrong. Please try again.";
    return { success: false, error: message };
  }
}
