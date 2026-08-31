// ---------------------------------------------------------------------------
// What a domain already ranks for, from a third-party index
// ---------------------------------------------------------------------------
//
// `discoverKeywords` answers "what could this site plausibly target". This
// answers the different and more useful question: "what does it rank for right
// now, on which page, at what position". Nothing here needs the site owner's
// cooperation, because rank data is an observation of the public SERP rather
// than something read out of their analytics.
//
// That distinction is the whole free-check pitch. "Here are some keywords in
// your space" is a generic report anyone could produce. "This post of yours sits
// at position 14 for a term with 1,900 searches a month, one revision from page
// one" is specific to them, and it is the input `recommendKeywords` already
// knows how to score: striking distance is its largest multiplier.
//
// SHAPE WARNING. This parser has not yet been run against a live response. Two
// sibling parsers in this codebase (`keywords_for_keywords`, `keywords_for_site`)
// returned zero rows for as long as they existed, with green unit tests, because
// they assumed `result[].items` where the API returns the row in `result[]`
// directly. So this reads both layouts, treats every field as optional, and
// returns an empty array rather than throwing when it meets something it does
// not recognise. Run `npm run ranked -- <domain>` against real credentials and
// confirm a non-zero row count before trusting any number that comes out of it.

import { post } from "./client";

/** A keyword the target domain currently ranks for. */
export interface RankedKeyword {
  keyword: string;
  /** Absolute SERP position, 1-based. Null when the payload omits it. */
  position: number | null;
  /** The page of theirs that ranks, which is what makes the finding specific. */
  url: string | null;
  /** Monthly search volume, or null when unknown. Never coerce this to 0. */
  volume: number | null;
  /** 0-100 difficulty, or null when unknown. Never coerce this to 0. */
  difficulty: number | null;
  cpc: number | null;
  /** True when the ranking URL is a blog-shaped path, used to scope the audit. */
  isBlogUrl: boolean;
}

/**
 * A ranked-keywords row. Every field optional on purpose: this is an external
 * payload we do not control, and a missing field must degrade to null rather
 * than throw.
 */
type DFSRankedItem = {
  keyword_data?: {
    keyword?: string | null;
    keyword_info?: {
      search_volume?: number | null;
      cpc?: number | null;
    } | null;
    keyword_properties?: {
      keyword_difficulty?: number | null;
    } | null;
  } | null;
  ranked_serp_element?: {
    serp_item?: {
      rank_absolute?: number | null;
      rank_group?: number | null;
      relative_url?: string | null;
      url?: string | null;
    } | null;
  } | null;
  // Some payloads flatten the keyword to the top level.
  keyword?: string | null;
};

type RankedKeywordsResult = {
  items?: DFSRankedItem[] | null;
  items_count?: number | null;
  total_count?: number | null;
};

/** Paths that indicate editorial content rather than a product or nav page. */
const BLOG_PATH = /\/(blog|posts?|articles?|news|insights|guides?|resources?)\//i;

function looksLikeBlog(url: string | null): boolean {
  if (!url) return false;
  try {
    return BLOG_PATH.test(new URL(url, "https://placeholder.invalid").pathname);
  } catch {
    return BLOG_PATH.test(url);
  }
}

/** Null unless the value is a usable finite number. Guards against "" and NaN. */
function num(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** Maps one payload row, or null when it carries no usable keyword. */
export function parseRankedItem(item: DFSRankedItem): RankedKeyword | null {
  const kd = item.keyword_data ?? undefined;
  const keyword = (kd?.keyword ?? item.keyword ?? "").trim();
  if (!keyword) return null;

  const serp = item.ranked_serp_element?.serp_item ?? undefined;
  // rank_absolute counts every SERP feature, rank_group counts organic blocks.
  // Absolute is what a human sees when they scroll, so prefer it.
  const position = num(serp?.rank_absolute) ?? num(serp?.rank_group);
  const url = (serp?.url ?? serp?.relative_url ?? null) || null;

  return {
    keyword,
    position,
    url,
    volume: num(kd?.keyword_info?.search_volume),
    difficulty: num(kd?.keyword_properties?.keyword_difficulty),
    cpc: num(kd?.keyword_info?.cpc),
    isBlogUrl: looksLikeBlog(url),
  };
}

/**
 * Fetch the keywords `domain` currently ranks for.
 *
 * Returns an empty array rather than throwing when the payload is unrecognised,
 * so a first-look analysis degrades to "no rank data" instead of failing whole.
 */
export async function fetchRankedKeywords(
  domain: string,
  options?: {
    languageCode?: string;
    locationCode?: number;
    /** Bounded so a first look cannot bill for tens of thousands of rows. */
    limit?: number;
  },
): Promise<RankedKeyword[]> {
  const languageCode = options?.languageCode ?? "en";
  const locationCode = options?.locationCode ?? 2840;
  const limit = options?.limit ?? 500;

  const response = await post<RankedKeywordsResult>(
    "/dataforseo_labs/google/ranked_keywords/live",
    [
      {
        target: domain.replace(/^https?:\/\//, "").replace(/^www\./, ""),
        language_code: languageCode,
        location_code: locationCode,
        limit,
        // Keep the payload to genuinely ranking terms.
        order_by: ["ranked_serp_element.serp_item.rank_absolute,asc"],
      },
    ],
  );

  const out: RankedKeyword[] = [];

  for (const task of response.tasks ?? []) {
    if (!task.result) continue;

    for (const result of task.result) {
      // The documented trap: some endpoints wrap rows in `result[].items`,
      // others put the row directly in `result[]`. Accept both.
      const items = Array.isArray(result?.items) ? result.items : [result as unknown as DFSRankedItem];

      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const parsed = parseRankedItem(item);
        if (parsed) out.push(parsed);
      }
    }
  }

  return out;
}

/**
 * Attach ranked keywords to the pages that earn them.
 *
 * The join is what turns a keyword list into a finding about *their* content:
 * a reviewer sees "/blog/x ranks 14th for y" rather than a detached table.
 * Matching is on pathname so that http/https, www, and trailing-slash variants
 * do not split a page into several.
 */
export function groupByPage(
  ranked: RankedKeyword[],
): Map<string, RankedKeyword[]> {
  const byPage = new Map<string, RankedKeyword[]>();

  for (const kw of ranked) {
    if (!kw.url) continue;
    let key: string;
    try {
      key = new URL(kw.url, "https://placeholder.invalid").pathname.replace(/\/$/, "") || "/";
    } catch {
      key = kw.url;
    }
    const bucket = byPage.get(key);
    if (bucket) bucket.push(kw);
    else byPage.set(key, [kw]);
  }

  // Strongest position first, so the summary line for a page is its best rank.
  for (const bucket of byPage.values()) {
    bucket.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  }

  return byPage;
}

/** Keywords sitting close enough to page one that one revision could move them. */
export function strikingDistance(
  ranked: RankedKeyword[],
  opts?: { min?: number; max?: number },
): RankedKeyword[] {
  const min = opts?.min ?? 8;
  const max = opts?.max ?? 30;
  return ranked
    .filter((k) => k.position !== null && k.position >= min && k.position <= max)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
}
