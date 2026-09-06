"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { getToolBySlug } from "@/lib/tools/registry";
import { generateMetaDescriptions } from "@/lib/tools/generate-meta";
import type { MetaDescriptionResult } from "@/lib/tools/types";

const TOOL = getToolBySlug("meta-description-generator")!;

const metaSchema = z.object({
  keyword: z
    .string()
    .min(2, "Keyword must be at least 2 characters")
    .max(100, "Keyword must be under 100 characters"),
  url: z.string().url("Please enter a valid URL").optional().or(z.literal("")),
});

export type MetaActionState = {
  success: boolean;
  result?: MetaDescriptionResult;
  error?: string;
};

export async function generateMetaAction(
  _prevState: MetaActionState,
  formData: FormData,
): Promise<MetaActionState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  if (!checkToolRateLimit(TOOL.slug, ip, TOOL.rateLimit, TOOL.rateWindowMs)) {
    return {
      success: false,
      error: `Rate limit reached — ${TOOL.rateLimit} generations per hour. Try again later.`,
    };
  }

  const rawUrl = (formData.get("url") as string)?.trim() || undefined;
  const parsed = metaSchema.safeParse({
    keyword: formData.get("keyword"),
    url: rawUrl,
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  try {
    const result = await generateMetaDescriptions(
      parsed.data.keyword,
      parsed.data.url || undefined,
    );
    return { success: true, result };
  } catch (err) {
    console.error("[meta-gen-action]", err);
    return {
      success: false,
      error: "Something went wrong. Please try again.",
    };
  }
}
