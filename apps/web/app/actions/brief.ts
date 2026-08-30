"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { generateBrief } from "@/lib/tools/generate-brief";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { getToolBySlug } from "@/lib/tools/registry";
import type { ContentBrief } from "@/lib/tools/types";

const TOOL = getToolBySlug("content-brief-generator")!;

const briefSchema = z.object({
  keyword: z
    .string()
    .min(2, "Keyword must be at least 2 characters")
    .max(100, "Keyword must be under 100 characters"),
  locale: z.string().optional(),
});

export type BriefActionState = {
  success: boolean;
  brief?: ContentBrief;
  error?: string;
};

export async function generateBriefAction(
  _prevState: BriefActionState,
  formData: FormData,
): Promise<BriefActionState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  if (!checkToolRateLimit(TOOL.slug, ip, TOOL.rateLimit, TOOL.rateWindowMs)) {
    return {
      success: false,
      error: `Rate limit reached — ${TOOL.rateLimit} briefs per hour. Try again later.`,
    };
  }

  const parsed = briefSchema.safeParse({
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
    const brief = await generateBrief(parsed.data.keyword, parsed.data.locale);
    return { success: true, brief };
  } catch (err) {
    console.error("[brief-action]", err);
    return {
      success: false,
      error: "Something went wrong generating the brief. Please try again.",
    };
  }
}
