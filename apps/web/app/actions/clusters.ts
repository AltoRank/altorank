"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { getToolBySlug } from "@/lib/tools/registry";
import { generateClusters } from "@/lib/tools/generate-clusters";
import type { KeywordClusterResult } from "@/lib/tools/types";

const TOOL = getToolBySlug("keyword-cluster-mapper")!;

const clusterSchema = z.object({
  keywords: z
    .string()
    .min(2, "Please enter at least one keyword")
    .max(500, "Too many keywords"),
  locale: z.string().optional(),
});

export type ClustersActionState = {
  success: boolean;
  result?: KeywordClusterResult;
  error?: string;
};

export async function clusterKeywordsAction(
  _prevState: ClustersActionState,
  formData: FormData,
): Promise<ClustersActionState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  if (!checkToolRateLimit(TOOL.slug, ip, TOOL.rateLimit, TOOL.rateWindowMs)) {
    return {
      success: false,
      error: `Rate limit reached — ${TOOL.rateLimit} clusters per hour. Try again later.`,
    };
  }

  const parsed = clusterSchema.safeParse({
    keywords: formData.get("keywords"),
    locale: formData.get("locale") || undefined,
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  // Parse comma-separated keywords, limit to 20
  const seeds = parsed.data.keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 20);

  if (seeds.length === 0) {
    return { success: false, error: "Please enter at least one keyword" };
  }

  try {
    const result = await generateClusters(seeds, parsed.data.locale);
    return { success: true, result };
  } catch (err) {
    console.error("[clusters-action]", err);
    return {
      success: false,
      error: "Something went wrong clustering keywords. Please try again.",
    };
  }
}
