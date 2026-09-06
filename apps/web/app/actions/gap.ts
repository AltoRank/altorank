"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { getToolBySlug } from "@/lib/tools/registry";
import { generateKeywordGap } from "@/lib/tools/generate-gap";
import type { KeywordGapResult } from "@/lib/tools/types";

const TOOL = getToolBySlug("keyword-gap-analyzer")!;

const domainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;

const gapSchema = z.object({
  yourDomain: z
    .string()
    .min(3, "Please enter your domain")
    .refine((v) => domainPattern.test(v), "Please enter a valid domain (e.g. example.com)"),
  competitor1: z
    .string()
    .min(3, "Please enter at least one competitor domain")
    .refine((v) => domainPattern.test(v), "Invalid competitor domain"),
  competitor2: z
    .string()
    .optional()
    .refine((v) => !v || domainPattern.test(v), "Invalid competitor domain"),
  competitor3: z
    .string()
    .optional()
    .refine((v) => !v || domainPattern.test(v), "Invalid competitor domain"),
  locale: z.string().optional(),
});

export type GapActionState = {
  success: boolean;
  result?: KeywordGapResult;
  error?: string;
};

export async function analyzeGapAction(
  _prevState: GapActionState,
  formData: FormData,
): Promise<GapActionState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  if (!checkToolRateLimit(TOOL.slug, ip, TOOL.rateLimit, TOOL.rateWindowMs)) {
    return {
      success: false,
      error: `Rate limit reached — ${TOOL.rateLimit} analyses per hour. Try again later.`,
    };
  }

  const parsed = gapSchema.safeParse({
    yourDomain: (formData.get("yourDomain") as string)?.trim(),
    competitor1: (formData.get("competitor1") as string)?.trim(),
    competitor2: (formData.get("competitor2") as string)?.trim() || undefined,
    competitor3: (formData.get("competitor3") as string)?.trim() || undefined,
    locale: formData.get("locale") || undefined,
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const competitors = [
    parsed.data.competitor1,
    parsed.data.competitor2,
    parsed.data.competitor3,
  ].filter(Boolean) as string[];

  try {
    const result = await generateKeywordGap(
      parsed.data.yourDomain,
      competitors,
      parsed.data.locale,
    );
    return { success: true, result };
  } catch (err) {
    console.error("[gap-action]", err);
    return {
      success: false,
      error: "Something went wrong analyzing keyword gaps. Please try again.",
    };
  }
}
