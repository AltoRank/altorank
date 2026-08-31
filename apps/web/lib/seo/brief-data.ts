// ---------------------------------------------------------------------------
// DataForSEO fetchers for the Content Brief pipeline
// ---------------------------------------------------------------------------

import { post } from "./client";

// ── SERP Advanced ──────────────────────────────────────────────────────────

type DFSSerpAdvancedItem = {
  type: string;
  rank_group: number;
  title: string;
  url: string;
  description: string;
  domain: string;
  breadcrumb: string | null;
  extra?: {
    word_count?: number | null;
  };
  /** Present on `ai_overview`: the rendered answer Google is showing. */
  markdown?: string | null;
  /** Present on `ai_overview`: the pages that answer cites. */
  references?: Array<{
    domain?: string | null;
    url?: string | null;
    title?: string | null;
    source?: string | null;
  }> | null;
  items?: Array<{
    type: string;
    title: string;
    description?: string;
  }>;
};

type SerpAdvancedResult = {
  keyword: string;
  items: DFSSerpAdvancedItem[] | null;
};

/**
 * What Google's own AI answer says for this query, and which pages it cites.
 *
 * This arrives in the SERP call we already pay for and used to be dropped on the
 * floor. For a product whose claim is AI visibility, it is the most direct
 * evidence available of what an AI answer currently contains and who it trusts:
 * the writer can see the ground already covered, and the specific competitors
 * that have to be displaced to earn a citation.
 *
 * null when the SERP has no AI Overview, which is a real and common state, not
 * an error. Never synthesise one.
 */
export type AiOverview = {
  markdown: string;
  citations: Array<{ domain: string; url: string; title: string }>;
};

export type SerpData = {
  organic: Array<{
    /** Google's own rank for this result. NOT the `position` field, which is
     *  DataForSEO's page-layout column ("left"/"right") and not a rank at all. */
    rank: number | null;
    title: string;
    url: string;
    description: string;
    domain: string;
    wordCount: number | null;
  }>;
  peopleAlsoAsk: string[];
  aiOverview: AiOverview | null;
};

export async function fetchAdvancedSerp(
  keyword: string,
  locale: { languageCode: string; locationCode: number },
): Promise<SerpData> {
  const response = await post<SerpAdvancedResult>(
    "/serp/google/organic/live/advanced",
    [
      {
        keyword,
        location_code: locale.locationCode,
        language_code: locale.languageCode,
      },
    ],
  );

  const organic: SerpData["organic"] = [];
  const peopleAlsoAsk: string[] = [];
  let aiOverview: AiOverview | null = null;

  for (const task of response.tasks) {
    if (!task.result) continue;

    for (const result of task.result) {
      if (!result.items) continue;

      for (const item of result.items) {
        if (item.type === "organic" && organic.length < 10) {
          organic.push({
            rank: typeof item.rank_group === "number" ? item.rank_group : null,
            title: item.title,
            url: item.url,
            description: item.description ?? "",
            domain: item.domain,
            wordCount: item.extra?.word_count ?? null,
          });
        }

        if (item.type === "people_also_ask" && item.items) {
          for (const paa of item.items) {
            if (paa.title) peopleAlsoAsk.push(paa.title);
          }
        }

        if (item.type === "ai_overview" && item.markdown) {
          aiOverview = {
            markdown: item.markdown,
            citations: (item.references ?? [])
              .filter((r) => r.url)
              .map((r) => ({
                domain: r.domain ?? "",
                url: r.url ?? "",
                title: r.title ?? r.source ?? "",
              })),
          };
        }
      }
    }
  }

  return { organic, peopleAlsoAsk, aiOverview };
}

// ── Related Keywords ───────────────────────────────────────────────────────

type DFSKeywordForKeywordItem = {
  keyword: string;
  /** Present on the flat shape. */
  search_volume?: number | null;
  competition_index?: number | null;
  /** Present on the wrapped shape. */
  keyword_info?: {
    search_volume: number | null;
    competition: number | null;
  };
};

/**
 * `keywords_for_keywords` returns its keywords as the `result` array itself,
 * NOT wrapped in a `result[].items` array the way the SERP endpoints do.
 *
 * This was previously typed and parsed as the wrapped shape, so the parser hit
 * `if (!result.items) continue` on every entry and the function always returned
 * an empty list: a live call returning 1,460 keywords produced zero. Both
 * shapes are accepted here so the fix does not depend on the response never
 * changing back.
 */
type KeywordsForKeywordsResult = DFSKeywordForKeywordItem & {
  items?: DFSKeywordForKeywordItem[] | null;
};

export type RelatedKeyword = {
  keyword: string;
  searchVolume: number | null;
  competition: number | null;
};

export async function fetchRelatedKeywords(
  keyword: string,
  locale: { languageCode: string; locationCode: number },
): Promise<RelatedKeyword[]> {
  const response = await post<KeywordsForKeywordsResult>(
    "/keywords_data/google_ads/keywords_for_keywords/live",
    [
      {
        keywords: [keyword],
        location_code: locale.locationCode,
        language_code: locale.languageCode,
      },
    ],
  );

  const results: RelatedKeyword[] = [];
  const seen = new Set<string>();

  for (const task of response.tasks) {
    if (!task.result) continue;

    for (const result of task.result) {
      // Flat shape (what this endpoint actually returns) or wrapped shape.
      const items = Array.isArray(result.items) ? result.items : [result];

      for (const item of items) {
        if (!item?.keyword) continue;
        const term = item.keyword.toLowerCase();
        if (term === keyword.toLowerCase() || seen.has(term)) continue;
        seen.add(term);

        results.push({
          keyword: item.keyword,
          // Volume and competition sit at the top level on the flat shape and
          // under `keyword_info` on the wrapped one.
          searchVolume: item.keyword_info?.search_volume ?? item.search_volume ?? null,
          competition: item.keyword_info?.competition ?? item.competition_index ?? null,
        });
      }
    }
  }

  // Highest demand first: the list is truncated, so an arbitrary 30 from an
  // alphabetical 1,460 would mostly be noise.
  return results
    .sort((a, b) => (b.searchVolume ?? 0) - (a.searchVolume ?? 0))
    .slice(0, 30);
}
