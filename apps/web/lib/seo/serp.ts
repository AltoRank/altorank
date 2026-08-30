// ---------------------------------------------------------------------------
// SERP position tracking via DataForSEO
// ---------------------------------------------------------------------------

import { post } from "./client";

/** Single organic SERP item from DataForSEO. */
type DFSSerpItem = {
  type: string;
  rank_group: number;
  rank_absolute: number;
  domain: string;
  url: string;
  title: string;
};

/** Result wrapper for a single SERP task. */
type SerpTaskResult = {
  keyword: string;
  items: DFSSerpItem[] | null;
};

export type RankingResult = {
  keyword: string;
  position: number | null;
  url: string | null;
};

/**
 * Check where `domain` ranks for each keyword using
 * DataForSEO's SERP organic live/regular endpoint.
 */
export async function checkRankings(
  keywords: string[],
  domain: string,
  options?: { languageCode?: string; locationCode?: number },
): Promise<RankingResult[]> {
  if (keywords.length === 0) return [];

  const languageCode = options?.languageCode ?? "en";
  const locationCode = options?.locationCode ?? 2840;

  // Normalise domain for matching (strip protocol + trailing slash)
  const normalisedDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();

  const tasks = keywords.map((keyword) => ({
    keyword,
    location_code: locationCode,
    language_code: languageCode,
  }));

  const response = await post<SerpTaskResult>(
    "/serp/google/organic/live/regular",
    tasks,
  );

  const results: RankingResult[] = [];

  for (const task of response.tasks) {
    if (!task.result) continue;

    for (const result of task.result) {
      const kw = result.keyword;
      let position: number | null = null;
      let url: string | null = null;

      if (result.items) {
        for (const item of result.items) {
          if (item.type !== "organic") continue;

          const itemDomain = (item.domain ?? "")
            .replace(/^www\./, "")
            .toLowerCase();

          if (
            itemDomain === normalisedDomain ||
            itemDomain === `www.${normalisedDomain}`
          ) {
            position = item.rank_group;
            url = item.url;
            break;
          }
        }
      }

      results.push({ keyword: kw, position, url });
    }
  }

  return results;
}
