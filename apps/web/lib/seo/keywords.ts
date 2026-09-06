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

/**
 * The CPC as it should be written to `keywords.cpc`.
 *
 * The parsers above default a missing `keyword_info.cpc` to 0, which is fine
 * for sorting a research table and wrong for storage: the traffic-value
 * estimate reads null as "unmeasured" and a number as a price, and a term
 * with no advertiser data is the first, not a term that clicks for free.
 * Every writer goes through this so the column never learns the difference.
 */
export function storedCpc(cpc: number | null | undefined): number | null {
  return typeof cpc === "number" && Number.isFinite(cpc) && cpc > 0 ? cpc : null;
}

/** Labs returns difficulty; the Ads endpoint that lists keywords does not. */
type LabsOverviewResult = {
  items: Array<{
    keyword: string;
    keyword_properties?: { keyword_difficulty?: number | null };
    keyword_info?: { search_volume?: number | null; cpc?: number | null };
  }> | null;
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

/**
 * Volume and difficulty for keywords that arrived outside discovery.
 *
 * A keyword typed into the "New article" modal never went through
 * `discoverKeywords`, so the article stored volume null and difficulty null
 * and the editor's dials read as dashes on a piece the machine had just
 * researched. One overview call answers both numbers.
 *
 * Absent stays null. `null` here means "the API did not report it", and
 * rendering that as 0 is the difficulty-coloured-green bug all over again.
 */
export async function fetchKeywordFacts(
  keywords: string[],
  options?: { languageCode?: string; locationCode?: number },
): Promise<Map<string, { volume: number | null; difficulty: number | null; cpc: number | null }>> {
  const out = new Map<
    string,
    { volume: number | null; difficulty: number | null; cpc: number | null }
  >();
  if (!keywords.length) return out;

  const response = await post<LabsOverviewResult>(
    "/dataforseo_labs/google/keyword_overview/live",
    [
      {
        keywords: keywords.slice(0, DIFFICULTY_BATCH),
        location_code: options?.locationCode ?? 2840,
        language_code: options?.languageCode ?? "en",
      },
    ],
  );

  for (const task of response.tasks) {
    for (const result of task.result ?? []) {
      for (const item of result.items ?? []) {
        out.set(item.keyword.toLowerCase(), {
          volume: item.keyword_info?.search_volume ?? null,
          difficulty: item.keyword_properties?.keyword_difficulty ?? null,
          cpc: storedCpc(item.keyword_info?.cpc),
        });
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

// ---------------------------------------------------------------------------
// Keywords from what the site says about itself
// ---------------------------------------------------------------------------
//
// `keywords_for_site` asks Google Ads what a domain is about, and for a small
// site it answers with the head of the category: www.lully.ai, an AI warehouse
// orchestration platform, came back as "artificial intelligence" 301,000/mo
// and nothing about warehouses. The site's own headings know better. This
// seeds DataForSEO Labs' keyword ideas with the topical profile's top terms,
// so the queue starts from "warehouse orchestration" rather than "ai tools".

type KeywordIdeasItem = {
  keyword?: string | null;
  keyword_info?: {
    search_volume?: number | null;
    cpc?: number | null;
    competition?: number | null;
  } | null;
  keyword_properties?: { keyword_difficulty?: number | null } | null;
  search_intent_info?: { main_intent?: string | null } | null;
};
type KeywordIdeasResult = { items?: KeywordIdeasItem[] | null };

export function parseKeywordIdea(
  item: KeywordIdeasItem,
  languageCode = "en",
): DiscoveredKeyword | null {
  const keyword = (item.keyword ?? "").trim();
  if (!keyword) return null;
  const volume = item.keyword_info?.search_volume ?? 0;
  return {
    keyword,
    volume: typeof volume === "number" ? volume : 0,
    difficulty:
      typeof item.keyword_properties?.keyword_difficulty === "number"
        ? item.keyword_properties.keyword_difficulty
        : null,
    cpc: item.keyword_info?.cpc ?? 0,
    competition: item.keyword_info?.competition ?? 0,
    intent: item.search_intent_info?.main_intent
      ? mapIntent(item.search_intent_info.main_intent)
      : classifyIntent(keyword, languageCode).intent,
  };
}

/**
 * Content words, order-insensitive. "seo content marketing" and "content
 * marketing seo" collapse to the same key.
 */
function permutationKey(term: string): string {
  const FILLER = new Set([
    "for",
    "the",
    "in",
    "of",
    "and",
    "a",
    "an",
    "to",
    "with",
    "is",
    "on",
    "or",
    "&",
  ]);
  return term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !FILLER.has(w))
    .sort()
    .join(" ");
}

/**
 * One keyword per idea, keeping the best-searched phrasing.
 *
 * keyword_suggestions returns every phrasing of a query as its own row: a
 * single "seo content" seed came back with "content marketing and seo", "seo
 * and content marketing", "seo marketing content", "content marketing seo",
 * "seo & content marketing" and four more, all at 1,300 a month. Each one is
 * individually clean - no repeated token, no fragment - so assessKeywordQuality
 * passes all nine, and they would take nine of the hundred slots to say one
 * thing.
 *
 * This is the same shape as the variant spam the old keywords_for_site path
 * produced ("ai of ai", "ai for ai"); it just arrives one layer later.
 */
export function dedupePermutations(
  keywords: DiscoveredKeyword[],
): DiscoveredKeyword[] {
  const best = new Map<string, DiscoveredKeyword>();
  for (const k of keywords) {
    const key = permutationKey(k.keyword);
    if (!key) continue;
    const prev = best.get(key);
    // Highest volume wins; on a tie the shorter phrasing, which is the one a
    // person is more likely to have typed.
    if (
      !prev ||
      k.volume > prev.volume ||
      (k.volume === prev.volume && k.keyword.length < prev.keyword.length)
    ) {
      best.set(key, k);
    }
  }
  return [...best.values()];
}

/**
 * Expand seeds into keywords that actually contain them.
 *
 * Was keyword_ideas, which expands by product *category* rather than by
 * phrase. That is how seeds drawn from altorank.co's own headings - "seo
 * content", "content engine" - returned "free people search" (246,000/mo) and
 * "1998 google": people-search tools share a category with SEO tools, so the
 * endpoint considers them ideas for the same site. Every one of them passed
 * the topical filter too, because altorank.co is a content site whose blog
 * headings contain "google", "search" and "free", giving it a 349-term profile
 * that discriminates almost nothing.
 *
 * keyword_suggestions only returns phrases containing the seed, so that whole
 * failure is structurally impossible rather than filtered afterwards. The cost
 * is one call per seed instead of one for all of them, which is why the seed
 * count is bounded.
 */
export async function discoverKeywordsFromSeeds(
  seeds: string[],
  options?: {
    languageCode?: string;
    locationCode?: number;
    limit?: number;
    /** Calls are per-seed now, so this bounds the spend of one discovery. */
    maxSeeds?: number;
    /** Drop long-tail noise server-side. */
    minVolume?: number;
  },
): Promise<DiscoveredKeyword[]> {
  const clean = [
    ...new Set(
      seeds.map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3),
    ),
  ].slice(0, options?.maxSeeds ?? 5);
  if (!clean.length) return [];

  const minVolume = options?.minVolume ?? 100;
  const perSeed = Math.max(
    10,
    Math.floor((options?.limit ?? 100) / clean.length),
  );

  const responses = await Promise.all(
    clean.map((keyword) =>
      post<KeywordIdeasResult>(
        "/dataforseo_labs/google/keyword_suggestions/live",
        [
          {
            keyword,
            language_code: options?.languageCode ?? "en",
            location_code: options?.locationCode ?? 2840,
            limit: perSeed,
            filters: [["keyword_info.search_volume", ">", minVolume]],
            order_by: ["keyword_info.search_volume,desc"],
          },
        ],
      ).catch(() => null),
    ),
  );

  const out: DiscoveredKeyword[] = [];
  const seen = new Set<string>();
  for (const response of responses) {
    if (!response) continue;
    for (const task of response.tasks ?? []) {
      for (const result of task.result ?? []) {
        const items = Array.isArray(result?.items)
          ? result.items
          : [result as unknown as KeywordIdeasItem];
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const parsed = parseKeywordIdea(item, options?.languageCode ?? "en");
          if (!parsed || seen.has(parsed.keyword.toLowerCase())) continue;
          seen.add(parsed.keyword.toLowerCase());
          out.push(parsed);
        }
      }
    }
  }
  return dedupePermutations(out);
}
