import { post } from "./client";
import type { DiscoveredKeyword } from "./keywords";
import { classifyIntent } from "./intent";

/**
 * What the competition ranks for and this site does not.
 *
 * Uses DataForSEO's own gap endpoint rather than a diff computed here.
 * `domain_intersection` with `intersections: false` returns exactly "keywords
 * target1 ranks for and target2 does not", filtered and sorted server-side,
 * in one call per competitor. The first version of this fetched every
 * competitor's full ranked list plus our own and subtracted them in memory:
 * the same answer, more calls, and no way to bound the result by volume,
 * difficulty or the competitor's own position.
 *
 * The argument order is the part to get right, and the docs are explicit
 * about it: the domain you want the gap FOR goes in `target2`. So target1 is
 * the competitor and target2 is us.
 *
 * ## This does not work for a new site, and does not pretend to
 *
 * Competitors come from ranking overlap, so a site that ranks for almost
 * nothing has no competitors to compute a gap against - only the platforms
 * that rank for everything. Measured on 2026-09-02:
 *
 *   cal.com       -> zapier.com, calendly.com, apple.com   (1,300+ shared)
 *   altorank.co   -> youtube.com, instarank.com, facebook.com  (7 shared)
 *   supalabs.co   -> youtube.com, reddit.com, linkedin.com  (20 shared)
 *
 * Taking the gap against youtube.com or reddit.com means importing the whole
 * internet, which is how an earlier attempt filled supalabs.co with "how to
 * combine two columns in excel". So this returns nothing at all rather than
 * something wrong, and spends nothing doing it: if no competitor clears the
 * bar, the intersection calls never happen.
 */

/**
 * Domains that rank for everything and compete with nothing.
 *
 * `exclude_top_domains` does not remove these - it left apple.com and
 * microsoft.com in cal.com's list - so the judgement is made here. A gap
 * against a platform is not a content plan.
 */
const PLATFORMS = new Set([
  "youtube.com", "facebook.com", "reddit.com", "linkedin.com", "medium.com",
  "instagram.com", "tiktok.com", "x.com", "twitter.com", "pinterest.com",
  "quora.com", "wikipedia.org", "amazon.com", "apple.com", "microsoft.com",
  "google.com", "github.com", "substack.com",
]);

/** Shared ranking keywords a domain needs before it is worth measuring. */
const MIN_SHARED_KEYWORDS = 25;

/**
 * The share of a domain's OWN keywords that overlap with ours.
 *
 * Raw overlap count ranks the biggest site first, not the closest one, and
 * that single mistake produced every bad keyword this feature has emitted.
 * Measured on cal.com:
 *
 *   calendly.com     1,302 shared of     10,913   11.9%   a real peer
 *   youcanbook.me    1,012 shared of     11,135    9.1%   a real peer
 *   zapier.com       1,339 shared of    200,318    0.67%  ranks for everything
 *   microsoft.com    1,042 shared of  2,062,210    0.05%
 *   apple.com        1,252 shared of 18,865,792    0.01%
 *
 * Sorted by count, zapier.com came first and cal.com's gap led with "chatgpt",
 * "google form" and "copilot" - Zapier's content, not cal.com's market. The
 * ratio separates the two cleanly and needs no extra call: full_domain_metrics
 * is in the same response.
 */
const MIN_OVERLAP_SHARE = 0.05;

type CompetitorItem = {
  domain?: string | null;
  avg_position?: number | null;
  metrics?: { organic?: { count?: number | null } | null } | null;
  full_domain_metrics?: { organic?: { count?: number | null } | null } | null;
};

type IntersectionItem = {
  keyword_data?: {
    keyword?: string | null;
    keyword_info?: { search_volume?: number | null; cpc?: number | null } | null;
    keyword_properties?: { keyword_difficulty?: number | null } | null;
  } | null;
  first_domain_serp_element?: { rank_absolute?: number | null } | null;
};

export type GapKeywordRow = DiscoveredKeyword & {
  /** Which competitor holds it, and where. Shown as the reason for the pick. */
  competitor: string;
  competitorPosition: number | null;
};

const norm = (d: string) => d.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();

/** Competitors worth comparing against, or [] when there are none. */
export async function fetchComparableCompetitors(
  domain: string,
  options?: { languageCode?: string; locationCode?: number; limit?: number },
): Promise<Array<{ domain: string; shared: number; overlap: number }>> {
  const target = norm(domain);
  const res = await post<{ items?: CompetitorItem[] | null }>(
    "/dataforseo_labs/google/competitors_domain/live",
    [
      {
        target,
        language_code: options?.languageCode ?? "en",
        location_code: options?.locationCode ?? 2840,
        exclude_top_domains: true,
        filters: [["metrics.organic.count", ">", MIN_SHARED_KEYWORDS]],
        order_by: ["metrics.organic.count,desc"],
        limit: options?.limit ?? 10,
      },
    ],
  ).catch(() => null);

  return rankCompetitors(res?.tasks?.[0]?.result?.[0]?.items ?? [], target);
}

/** The judgement, separated from the call so it can be tested without one. */
export function rankCompetitors(
  items: CompetitorItem[],
  target: string,
): Array<{ domain: string; shared: number; overlap: number }> {
  const self = norm(target);
  const out: Array<{ domain: string; shared: number; overlap: number }> = [];
  for (const it of items) {
    const d = it?.domain ? norm(it.domain) : "";
    // The endpoint returns the target itself, every time.
    if (!d || d === self) continue;
    if (PLATFORMS.has(d)) continue;
    const shared = it.metrics?.organic?.count ?? 0;
    const theirTotal = it.full_domain_metrics?.organic?.count ?? 0;
    // No total means we cannot judge closeness, and a competitor we cannot
    // judge is one we should not take a content plan from.
    if (!theirTotal) continue;
    const overlap = shared / theirTotal;
    if (overlap < MIN_OVERLAP_SHARE) continue;
    out.push({ domain: d, shared, overlap });
  }
  // Closest first, not biggest first.
  return out.sort((a, b) => b.overlap - a.overlap);
}

export async function fetchCompetitorGap(
  domain: string,
  options?: {
    languageCode?: string;
    locationCode?: number;
    maxCompetitors?: number;
    minVolume?: number;
    maxCompetitorRank?: number;
    /** Cap KD server-side. A head term nobody can win is not a plan. */
    maxDifficulty?: number;
    limitPerCompetitor?: number;
  },
): Promise<GapKeywordRow[]> {
  const languageCode = options?.languageCode ?? "en";
  const locationCode = options?.locationCode ?? 2840;
  const target = norm(domain);

  const rivals = await fetchComparableCompetitors(domain, { languageCode, locationCode });
  if (!rivals.length) return [];

  const picked = rivals.slice(0, options?.maxCompetitors ?? 3);
  const responses = await Promise.all(
    picked.map((r) =>
      post<{ items?: IntersectionItem[] | null }>(
        "/dataforseo_labs/google/domain_intersection/live",
        [
          {
            // Order matters: the gap is computed FOR target2.
            target1: r.domain,
            target2: target,
            language_code: languageCode,
            location_code: locationCode,
            intersections: false,
            filters: [
              ["keyword_data.keyword_info.search_volume", ">", options?.minVolume ?? 100],
              "and",
              // A competitor's position 80 is not a keyword they own.
              ["first_domain_serp_element.rank_absolute", "<=", options?.maxCompetitorRank ?? 20],
              "and",
              // Without this the list is the competitor's off-market content:
              // cal.com's gap against zapier.com led with "chatgpt" (124M/mo,
              // KD 100), "copilot" and the misspelling "gemijni". Zapier ranks
              // for those; a scheduling tool will not, and nor will anyone.
              [
                "keyword_data.keyword_properties.keyword_difficulty",
                "<=",
                options?.maxDifficulty ?? 60,
              ],
            ],
            order_by: ["keyword_data.keyword_info.search_volume,desc"],
            limit: options?.limitPerCompetitor ?? 50,
          },
        ],
      )
        .then((res) => ({ rival: r.domain, res }))
        .catch(() => null),
    ),
  );

  // Best position wins: a term two competitors hold on page one is a stronger
  // signal than one held at 19.
  const best = new Map<string, GapKeywordRow>();
  for (const entry of responses) {
    if (!entry) continue;
    for (const item of entry.res?.tasks?.[0]?.result?.[0]?.items ?? []) {
      const keyword = item?.keyword_data?.keyword?.trim();
      if (!keyword) continue;
      const position = item.first_domain_serp_element?.rank_absolute ?? null;
      const key = keyword.toLowerCase();
      const prev = best.get(key);
      if (prev && (prev.competitorPosition ?? 999) <= (position ?? 999)) continue;
      best.set(key, {
        keyword,
        volume: item.keyword_data?.keyword_info?.search_volume ?? 0,
        difficulty: item.keyword_data?.keyword_properties?.keyword_difficulty ?? null,
        cpc: item.keyword_data?.keyword_info?.cpc ?? 0,
        competition: 0,
        intent: classifyIntent(keyword, languageCode).intent,
        competitor: entry.rival,
        competitorPosition: position,
      });
    }
  }
  return [...best.values()];
}
