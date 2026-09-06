// ---------------------------------------------------------------------------
// Content Brief pipeline orchestrator
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import {
  fetchAdvancedSerp,
  fetchRelatedKeywords,
  type SerpData,
  type RelatedKeyword,
} from "@/lib/seo/brief-data";
import { buildBriefPrompt } from "@/lib/ai/brief-prompt";
import { getLocale } from "@/lib/seo/locales";
import type { ContentBrief } from "./types";

import { anthropicModel } from "@/lib/ai/models";

export async function generateBrief(
  keyword: string,
  locale?: string,
): Promise<ContentBrief> {
  const loc = getLocale(locale ?? "en");
  const localeParam = {
    languageCode: loc.languageCode,
    locationCode: loc.locationCode,
  };

  // Fetch SERP + related keywords in parallel — gracefully degrade on failure
  const [serpResult, keywordsResult] = await Promise.allSettled([
    fetchAdvancedSerp(keyword, localeParam),
    fetchRelatedKeywords(keyword, localeParam),
  ]);

  const serpData: SerpData | null =
    serpResult.status === "fulfilled" ? serpResult.value : null;
  const relatedKeywords: RelatedKeyword[] =
    keywordsResult.status === "fulfilled" ? keywordsResult.value : [];

  // Build prompt and call Claude
  const { system, user } = buildBriefPrompt(keyword, serpData, relatedKeywords);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: anthropicModel("structured"),
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: user }],
  });

  // Extract text content from response
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Parse JSON — strip any accidental markdown fences
  const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);

  return {
    keyword,
    title: parsed.title ?? `Content Brief: ${keyword}`,
    metaDescription: parsed.metaDescription ?? "",
    outline: Array.isArray(parsed.outline) ? parsed.outline : [],
    lsiKeywords: Array.isArray(parsed.lsiKeywords) ? parsed.lsiKeywords : [],
    faqs: Array.isArray(parsed.faqs) ? parsed.faqs : [],
    wordCountTarget: parsed.wordCountTarget ?? 1500,
    competitorInsights: parsed.competitorInsights ?? "",
  };
}
