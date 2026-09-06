// ---------------------------------------------------------------------------
// Keyword gap analysis — find keywords competitors rank for that you don't
// ---------------------------------------------------------------------------

import { discoverKeywords, type DiscoveredKeyword } from "./keywords";
import type { GapKeyword } from "@/lib/tools/types";

/**
 * Compare keywords across domains to find gaps.
 * A "gap" is a keyword at least one competitor ranks for but the target domain doesn't.
 */
export async function findKeywordGaps(
  yourDomain: string,
  competitorDomains: string[],
  options?: { languageCode?: string; locationCode?: number },
): Promise<{ gaps: GapKeyword[]; totalGapsFound: number }> {
  // Fetch keywords for all domains in parallel
  const allDomains = [yourDomain, ...competitorDomains];
  const results = await Promise.allSettled(
    allDomains.map((domain) => discoverKeywords(domain, options)),
  );

  // Build keyword maps per domain
  const domainKeywords = new Map<string, Map<string, DiscoveredKeyword>>();
  for (let i = 0; i < allDomains.length; i++) {
    const result = results[i];
    const kwMap = new Map<string, DiscoveredKeyword>();
    if (result.status === "fulfilled") {
      for (const kw of result.value) {
        kwMap.set(kw.keyword.toLowerCase(), kw);
      }
    }
    domainKeywords.set(allDomains[i], kwMap);
  }

  // Typed fallbacks: a bare `new Map()` infers Map<any, any>, which widens the
  // union and makes every `kw` below `any`. That silently defeated the type
  // check on the fields copied into GapKeyword.
  const yourKeywords =
    domainKeywords.get(yourDomain) ?? new Map<string, DiscoveredKeyword>();

  // Find gaps: keywords competitors have that you don't
  const gapMap = new Map<string, GapKeyword>();

  for (const compDomain of competitorDomains) {
    const compKeywords =
      domainKeywords.get(compDomain) ?? new Map<string, DiscoveredKeyword>();

    for (const [kwLower, kw] of compKeywords) {
      // Skip if you already rank for this keyword
      if (yourKeywords.has(kwLower)) continue;

      if (!gapMap.has(kwLower)) {
        gapMap.set(kwLower, {
          keyword: kw.keyword,
          volume: kw.volume,
          difficulty: kw.difficulty,
          cpc: kw.cpc,
          intent: kw.intent,
          yourPosition: null,
          competitors: {},
        });
      }

      // Add competitor data
      const gap = gapMap.get(kwLower)!;
      gap.competitors[compDomain] = 1; // Indicates they rank (no exact position from this API)
    }
  }

  // Sort by volume descending
  const gaps = Array.from(gapMap.values()).sort((a, b) => b.volume - a.volume);

  return { gaps, totalGapsFound: gaps.length };
}
