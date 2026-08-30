// ---------------------------------------------------------------------------
// Keyword Cluster Mapper pipeline
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import { fetchRelatedKeywords } from "@/lib/seo/brief-data";
import { getLocale } from "@/lib/seo/locales";
import { buildClusterPrompt } from "@/lib/ai/cluster-prompt";
import type {
  KeywordClusterResult,
  KeywordCluster,
  ClusterKeyword,
} from "./types";

import { anthropicModel } from "@/lib/ai/models";

export async function generateClusters(
  seedKeywords: string[],
  locale?: string,
): Promise<KeywordClusterResult> {
  const loc = getLocale(locale ?? "en");
  const localeParam = {
    languageCode: loc.languageCode,
    locationCode: loc.locationCode,
  };

  // Expand keywords via DataForSEO — fetch related keywords for each seed
  const expansionResults = await Promise.allSettled(
    seedKeywords.map((kw) => fetchRelatedKeywords(kw, localeParam)),
  );

  // Build a deduplicated keyword map
  const keywordMap = new Map<
    string,
    { keyword: string; volume: number; difficulty: number }
  >();

  // Add seed keywords
  for (const seed of seedKeywords) {
    keywordMap.set(seed.toLowerCase(), {
      keyword: seed,
      volume: 0,
      difficulty: 0,
    });
  }

  // Add expanded keywords
  for (const result of expansionResults) {
    if (result.status !== "fulfilled") continue;
    for (const kw of result.value) {
      const key = kw.keyword.toLowerCase();
      if (!keywordMap.has(key)) {
        keywordMap.set(key, {
          keyword: kw.keyword,
          volume: kw.searchVolume ?? 0,
          difficulty: Math.round((kw.competition ?? 0) * 100),
        });
      }
    }
  }

  const expandedKeywords = Array.from(keywordMap.values())
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 100); // Cap at 100 keywords for the prompt

  if (expandedKeywords.length === 0) {
    return {
      seedKeywords,
      clusters: [],
      totalKeywords: 0,
      totalVolume: 0,
    };
  }

  // Cluster with Claude
  const { system, user } = buildClusterPrompt(seedKeywords, expandedKeywords);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: anthropicModel("structured"),
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);

  // Map AI clusters to typed result
  const clusters: KeywordCluster[] = [];

  if (Array.isArray(parsed.clusters)) {
    for (const c of parsed.clusters) {
      const clusterKeywords: ClusterKeyword[] = [];

      if (Array.isArray(c.keywords)) {
        for (const kwStr of c.keywords) {
          const data = keywordMap.get(String(kwStr).toLowerCase());
          clusterKeywords.push({
            keyword: String(kwStr),
            volume: data?.volume ?? 0,
            difficulty: data?.difficulty ?? 0,
          });
        }
      }

      const totalVolume = clusterKeywords.reduce(
        (sum, kw) => sum + kw.volume,
        0,
      );
      const avgDifficulty =
        clusterKeywords.length > 0
          ? Math.round(
              clusterKeywords.reduce((sum, kw) => sum + kw.difficulty, 0) /
                clusterKeywords.length,
            )
          : 0;

      clusters.push({
        name: String(c.name ?? "Unnamed Cluster"),
        theme: String(c.theme ?? ""),
        keywords: clusterKeywords,
        totalVolume,
        avgDifficulty,
        suggestedPageType: String(c.suggestedPageType ?? "blog post"),
      });
    }
  }

  // Sort clusters by total volume
  clusters.sort((a, b) => b.totalVolume - a.totalVolume);

  const totalKeywords = clusters.reduce(
    (sum, c) => sum + c.keywords.length,
    0,
  );
  const totalVolume = clusters.reduce((sum, c) => sum + c.totalVolume, 0);

  return { seedKeywords, clusters, totalKeywords, totalVolume };
}
