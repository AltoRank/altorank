"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { getToolBySlug } from "@/lib/tools/registry";
import { generateSerpAnalysis } from "@/lib/tools/generate-serp";
import type { SerpAnalysisResult } from "@/lib/tools/types";

const TOOL = getToolBySlug("serp-analyzer")!;

const serpSchema = z.object({
  keyword: z
    .string()
    .min(2, "Keyword must be at least 2 characters")
    .max(100, "Keyword must be under 100 characters"),
  locale: z.string().optional(),
});

export type SerpActionState = {
  success: boolean;
  result?: SerpAnalysisResult;
  error?: string;
};

export async function analyzeSerpAction(
  _prevState: SerpActionState,
  formData: FormData,
): Promise<SerpActionState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  if (!checkToolRateLimit(TOOL.slug, ip, TOOL.rateLimit, TOOL.rateWindowMs)) {
    return {
      success: false,
      error: `Rate limit reached — ${TOOL.rateLimit} analyses per hour. Try again later.`,
    };
  }

  const parsed = serpSchema.safeParse({
    keyword: formData.get("keyword"),
    locale: formData.get("locale") || undefined,
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  try {
    const result = await generateSerpAnalysis(
      parsed.data.keyword,
      parsed.data.locale,
    );
    return { success: true, result };
  } catch (err) {
    console.error("[serp-action]", err);
    return {
      success: false,
      error: "Something went wrong analyzing the SERP. Please try again.",
    };
  }
}
