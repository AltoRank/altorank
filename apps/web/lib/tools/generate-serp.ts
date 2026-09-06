// ---------------------------------------------------------------------------
// SERP Analyzer pipeline
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import { fetchAdvancedSerp } from "@/lib/seo/brief-data";
import { getLocale } from "@/lib/seo/locales";
import { buildSerpInsightsPrompt } from "@/lib/ai/serp-prompt";
import type { SerpAnalysisResult, SerpAnalysisItem } from "./types";

import { anthropicModel } from "@/lib/ai/models";

export async function generateSerpAnalysis(
  keyword: string,
  locale?: string,
): Promise<SerpAnalysisResult> {
  const loc = getLocale(locale ?? "en");
  const localeParam = {
    languageCode: loc.languageCode,
    locationCode: loc.locationCode,
  };

  const serpData = await fetchAdvancedSerp(keyword, localeParam);

  const organic: SerpAnalysisItem[] = serpData.organic.map((item, i) => ({
    position: i + 1,
    title: item.title,
    url: item.url,
    domain: item.domain,
    description: item.description,
    wordCount: item.wordCount,
  }));

  // Calculate average word count
  const withWordCount = organic.filter((r) => r.wordCount != null);
  const avgWordCount =
    withWordCount.length > 0
      ? Math.round(
          withWordCount.reduce((sum, r) => sum + (r.wordCount ?? 0), 0) /
            withWordCount.length,
        )
      : null;

  // Get AI insights
  let aiInsights = "";
  try {
    const { system, user } = buildSerpInsightsPrompt(
      keyword,
      organic,
      serpData.peopleAlsoAsk,
    );

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: anthropicModel("structured"),
      max_tokens: 512,
      system,
      messages: [{ role: "user", content: user }],
    });

    aiInsights = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  } catch {
    aiInsights = "";
  }

  return {
    keyword,
    locale: loc.label,
    organic,
    peopleAlsoAsk: serpData.peopleAlsoAsk,
    avgWordCount,
    aiInsights,
  };
}
