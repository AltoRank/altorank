// ---------------------------------------------------------------------------
// Keyword research via DataForSEO — "Keywords for Site"
// ---------------------------------------------------------------------------

import { post } from "./client";
import { classifyIntent } from "./intent";
import type { KeywordIntent } from "@/lib/types";

/** Shape returned by the keywords-for-site DataForSEO endpoint (trimmed). */
type DFSKeywordItem = {
  keyword: string;
  search_volume: number | null;
  keyword_info?: {
    search_volume: number | null;
    competition_level: string | null;
    competition: number | null;
    cpc: number | null;
  };
  keyword_properties?: {
    keyword_difficulty: number | null;
  };
  search_intent_info?: {
    main_intent: string | null;
  };
  competition: number | null;
  cpc: number | null;
};

/**
 * Result shape for the keywords-for-site task.
 *
 * Like `keywords_for_keywords`, this endpoint returns its keywords as the
 * `result` array itself rather than wrapped in `result[].items`. It was typed
 * and parsed as the wrapped shape, so the `if (!result.items) continue` guard
 * skipped every entry: a live call returning 1,016 keywords produced none, and
 * keyword discovery has never returned a row. Both shapes are accepted so the
 * fix does not depend on the response never changing back.
 */
type KeywordsForSiteResult = DFSKeywordItem & {
  items?: DFSKeywordItem[] | null;
};

export type DiscoveredKeyword = {
  keyword: string;
  volume: number;
  /**
   * Organic ranking difficulty, 0-100, or null when unknown.
   *
   * Nullable on purpose. The Google Ads endpoint that returns the keywords
   * carries no difficulty at all, and defaulting to 0 is not a neutral
   * placeholder: the UI colours anything under 25 green, so every keyword
   * rendered as a green "0" and read as trivially winnable. An absent number
   * has to look absent.
   */
  difficulty: number | null;
  cpc: number;
  competition: number;
  intent: KeywordIntent;
};

/** Labs returns difficulty; the Ads endpoint that lists keywords does not. */
type LabsOverviewResult = {
  items:
    | Array<{
        keyword: string;
        keyword_properties?: { keyword_difficulty?: number | null };
      }>
    | null;
};

/** DataForSEO Labs accepts up to 700 keywords per task. */
const DIFFICULTY_BATCH = 700;

/**
 * Look up real organic difficulty for a set of keywords.
 *
 * Separate from discovery because it is a separate paid endpoint: callers that
 * only need the keyword set (competitor gap comparison, for instance) should
 * not pay for it. Returns a partial map; anything missing stays unknown rather
 * than becoming a guess.
 */
export async function fetchKeywordDifficulty(
  keywords: string[],
  options?: { languageCode?: string; locationCode?: number },
): Promise<Map<string, number>> {
  const languageCode = options?.languageCode ?? "en";
  const locationCode = options?.locationCode ?? 2840;
  const out = new Map<string, number>();
  if (!keywords.length) return out;

  const response = await post<LabsOverviewResult>(
    "/dataforseo_labs/google/keyword_overview/live",
    [
      {
        keywords: keywords.slice(0, DIFFICULTY_BATCH),
        location_code: locationCode,
        language_code: languageCode,
      },
    ],
  );

  for (const task of response.tasks) {
    for (const result of task.result ?? []) {
      for (const item of result.items ?? []) {
        const kd = item.keyword_properties?.keyword_difficulty;
        if (typeof kd === "number") out.set(item.keyword.toLowerCase(), kd);
      }
    }
  }

  return out;
}

/** Map DataForSEO intent strings to our union type. */
function mapIntent(raw: string | null | undefined): KeywordIntent {
  if (!raw) return "info";
  const lower = raw.toLowerCase();
  if (lower.includes("commercial")) return "commercial";
  if (lower.includes("transactional")) return "transactional";
  if (lower.includes("navigational")) return "navigational";
  return "info";
}

/**
 * Discover keywords for a given domain using DataForSEO's
 * "Keywords for Site" endpoint.
 */
export async function discoverKeywords(
  domain: string,
  options?: {
    languageCode?: string;
    locationCode?: number;
    /**
     * Look up real difficulty for the highest-volume results. Off by default
     * because it is a second paid endpoint, and callers that only need the
     * keyword set should not be billed for it.
     */
    withDifficulty?: boolean;
  },
): Promise<DiscoveredKeyword[]> {
  const languageCode = options?.languageCode ?? "en";
  const locationCode = options?.locationCode ?? 2840;

  const response = await post<KeywordsForSiteResult>(
    "/keywords_data/google_ads/keywords_for_site/live",
    [
      {
        target: domain,
        language_code: languageCode,
        location_code: locationCode,
      },
    ],
  );

  const results: DiscoveredKeyword[] = [];

  for (const task of response.tasks) {
    if (!task.result) continue;

    for (const result of task.result) {
      // Flat shape (what this endpoint actually returns) or wrapped shape.
      const items = Array.isArray(result.items) ? result.items : [result];

      for (const item of items) {
        if (!item?.keyword) continue;

        const volume =
          item.keyword_info?.search_volume ?? item.search_volume ?? 0;
        const difficulty = item.keyword_properties?.keyword_difficulty ?? null;
        const cpc = item.keyword_info?.cpc ?? item.cpc ?? 0;
        const competition =
          item.keyword_info?.competition ?? item.competition ?? 0;

        // The flat shape carries no `search_intent_info`, so every keyword
        // would otherwise be filed as informational. Fall back to the lexical
        // classifier, which needs no SERP call and is therefore affordable
        // across the thousand-plus keywords this endpoint returns.
        const intent = item.search_intent_info?.main_intent
          ? mapIntent(item.search_intent_info.main_intent)
          : classifyIntent(item.keyword, languageCode).intent;

        results.push({
          keyword: item.keyword,
          volume,
          difficulty,
          cpc,
          competition,
          intent,
        });
      }
    }
  }

  if (!options?.withDifficulty) return results;

  // One batch, highest volume first: those are the keywords anyone actually
  // plans against, and difficulty for the long tail is not worth a second call.
  const ranked = [...results].sort((a, b) => b.volume - a.volume);
  const lookup = await fetchKeywordDifficulty(
    ranked.slice(0, DIFFICULTY_BATCH).map((k) => k.keyword),
    { languageCode, locationCode },
  ).catch(() => new Map<string, number>()); // enrichment must not fail discovery

  for (const kw of results) {
    const kd = lookup.get(kw.keyword.toLowerCase());
    if (typeof kd === "number") kw.difficulty = kd;
  }

  return results;
}
