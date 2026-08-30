// ---------------------------------------------------------------------------
// Article research: everything the writer should know before drafting
// ---------------------------------------------------------------------------
//
// This module exists because the generation pipeline used to receive a keyword
// string and nothing else. The SERP fetchers, the keyword tools, the rank
// tracker and the Search Console sync all existed, and none of them reached the
// writer: their output went to dashboards and reports only.
//
// Every layer is optional and independently degradable. DataForSEO credentials
// are not required to self-host, and a workspace that has never connected
// Search Console still generates articles. What is NOT optional is saying which
// layers actually loaded: `layers` carries a status per source so a reviewer can
// tell "no competitor covers this" from "we could not see the competitors".

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchAdvancedSerp,
  fetchRelatedKeywords,
  type SerpData,
  type RelatedKeyword,
} from "./brief-data";
import { classifyIntent, type IntentClassification } from "./intent";
import { getLocale } from "./locales";
import { htmlToMarkdown } from "@/lib/audit/markdown";

export interface ResearchLayer {
  id: "serp" | "related_keywords" | "gsc" | "competitor_length";
  /** `ok` loaded, `unavailable` not configured, `failed` configured but errored. */
  status: "ok" | "unavailable" | "failed";
  detail: string;
}

export interface CompetitorPage {
  title: string;
  url: string;
  domain: string;
  description: string;
  wordCount: number | null;
}

export interface GscSignal {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface ArticleResearch {
  keyword: string;
  language: string;
  intent: IntentClassification;
  competitors: CompetitorPage[];
  peopleAlsoAsk: string[];
  relatedKeywords: RelatedKeyword[];
  /** Search Console evidence for this exact query, when the site already ranks. */
  existingPerformance: GscSignal | null;
  /** Related queries the site already gets impressions for. */
  adjacentQueries: GscSignal[];
  recommendedWordCount: number;
  wordCountBasis: string;
  layers: ResearchLayer[];
}

const DEFAULT_WORD_COUNT = 1500;
const MIN_WORD_COUNT = 800;
const MAX_WORD_COUNT = 3000;
const GSC_LOOKBACK_DAYS = 90;

/**
 * Normalise a rejection into a short, storable string.
 *
 * `layers` is persisted to `articles.research` and rendered in the editor, and
 * a DataForSEO 4xx embeds their whole response body in the error message. Left
 * uncapped that writes an unbounded blob of third-party text into every failed
 * article. Credentials are not a concern here (the auth header is built inside
 * the client and never reaches the message), but length is.
 */
function reasonToDetail(reason: unknown): string {
  const message =
    reason instanceof Error ? reason.message : String(reason ?? "unknown error");
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Target length from what already ranks, not from a fixed default.
 *
 * Aims slightly above the median rather than above the maximum: the longest
 * result is usually an outlier, and chasing it produces padding, which is the
 * failure mode that makes AI content obvious.
 */
function deriveWordCount(competitors: CompetitorPage[]): {
  target: number;
  basis: string;
} {
  const counts = competitors
    .map((c) => c.wordCount)
    .filter((n): n is number => typeof n === "number" && n > 0);

  // Two is enough. Requiring three sounds more rigorous but is worse in
  // practice: the pages that block a fetch are the big publishers, so on a
  // competitive SERP we routinely measure only two and would fall back to a
  // fixed default while holding real evidence about what ranks.
  if (counts.length < 2) {
    return {
      target: DEFAULT_WORD_COUNT,
      basis:
        counts.length === 0
          ? "no competitor word counts available; using the default"
          : `only ${counts.length} competitor word count(s) available; using the default`,
    };
  }

  const med = median(counts)!;
  const target = Math.round(Math.min(Math.max(med * 1.15, MIN_WORD_COUNT), MAX_WORD_COUNT) / 50) * 50;

  return {
    target,
    basis: `competitor median is ${Math.round(med)} words across ${counts.length} ranking pages`,
  };
}

// Attempt more than we need: on a competitive SERP the big publishers block
// bots, and measured coverage runs well under half of what is attempted.
const MEASURE_LIMIT = 8;
const MEASURE_TIMEOUT_MS = 8_000;
const UA =
  "Mozilla/5.0 (compatible; AltoRank-Research/1.0; +https://altorank.co; " +
  "content length measurement)";

/**
 * Measure how long the ranking pages actually are, by fetching them.
 *
 * DataForSEO's organic results carry an `extra.word_count` field, and on the
 * live/advanced endpoint it is never populated: `extra` comes back as `{}` for
 * every result. Trusting it meant `deriveWordCount` could never engage and the
 * target length silently fell back to the 1500 default on every single run,
 * which made the "length derived from what ranks" behaviour a no-op.
 *
 * So measure it directly. Reuses `htmlToMarkdown`, which already finds the
 * content boundary (main, then longest article, then body-minus-chrome) and
 * returns a word count for it, rather than counting the whole document
 * including navigation and footers.
 *
 * Bounded on purpose: top few results only, in parallel, with a short timeout,
 * and any failure just leaves that entry unmeasured. This runs on the path to
 * generating an article and must not become the slowest part of it.
 */
async function measureCompetitorLengths(
  competitors: CompetitorPage[],
): Promise<{ competitors: CompetitorPage[]; layer: ResearchLayer }> {
  const targets = competitors
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.wordCount === null && /^https?:\/\//i.test(c.url))
    .slice(0, MEASURE_LIMIT);

  if (!targets.length) {
    return {
      competitors,
      layer: {
        id: "competitor_length",
        status: competitors.length ? "ok" : "unavailable",
        detail: competitors.length
          ? "word counts already supplied by the SERP provider"
          : "no competitors to measure",
      },
    };
  }

  const measured = [...competitors];

  const results = await Promise.allSettled(
    targets.map(async ({ c, i }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MEASURE_TIMEOUT_MS);
      try {
        const res = await fetch(c.url, {
          signal: controller.signal,
          headers: { "User-Agent": UA },
          redirect: "follow",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const { words } = htmlToMarkdown(html, c.url);
        if (words > 0) measured[i] = { ...c, wordCount: words };
        return words > 0;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const ok = results.filter((r) => r.status === "fulfilled" && r.value).length;

  return {
    competitors: measured,
    layer: {
      id: "competitor_length",
      status: ok > 0 ? "ok" : "failed",
      detail:
        ok > 0
          ? `measured ${ok} of ${targets.length} ranking pages by fetching them`
          : `could not read any of the ${targets.length} pages attempted ` +
            `(blocked, slow or JavaScript-rendered)`,
    },
  };
}

/**
 * Pull Search Console history for this keyword from the synced metrics.
 *
 * Reads `analytics_metrics`, which the analytics cron populates, rather than
 * calling Google directly: the cron already handles token refresh, and article
 * generation should not fail because an access token expired.
 */
async function fetchGscSignals(
  supabase: SupabaseClient,
  workspaceId: string,
  keyword: string,
): Promise<{
  existing: GscSignal | null;
  adjacent: GscSignal[];
  layer: ResearchLayer;
}> {
  const since = new Date(Date.now() - GSC_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabase
    .from("analytics_metrics")
    .select("query, clicks, impressions, avg_position")
    .eq("workspace_id", workspaceId)
    .eq("source", "gsc")
    .gte("metric_date", since)
    .not("query", "is", null);

  if (error) {
    return {
      existing: null,
      adjacent: [],
      layer: { id: "gsc", status: "failed", detail: error.message },
    };
  }

  if (!data?.length) {
    return {
      existing: null,
      adjacent: [],
      layer: {
        id: "gsc",
        status: "unavailable",
        detail: "no Search Console data synced for this workspace",
      },
    };
  }

  // Roll daily rows up per query. Position is impression-weighted, because a
  // plain mean lets a single-impression day at position 3 outrank a thousand
  // impressions at position 40.
  const rollup = new Map<
    string,
    { clicks: number; impressions: number; positionXImpressions: number }
  >();

  for (const row of data as Array<{
    query: string | null;
    clicks: number | null;
    impressions: number | null;
    avg_position: number | null;
  }>) {
    if (!row.query) continue;
    const key = row.query.toLowerCase();
    const entry = rollup.get(key) ?? {
      clicks: 0,
      impressions: 0,
      positionXImpressions: 0,
    };
    const impressions = row.impressions ?? 0;
    entry.clicks += row.clicks ?? 0;
    entry.impressions += impressions;
    entry.positionXImpressions += (row.avg_position ?? 0) * impressions;
    rollup.set(key, entry);
  }

  const toSignal = (query: string, e: {
    clicks: number;
    impressions: number;
    positionXImpressions: number;
  }): GscSignal => ({
    query,
    clicks: e.clicks,
    impressions: e.impressions,
    position: e.impressions
      ? Math.round((e.positionXImpressions / e.impressions) * 10) / 10
      : 0,
  });

  const target = keyword.toLowerCase().trim();
  const exact = rollup.get(target);
  const existing = exact ? toSignal(target, exact) : null;

  // Adjacent = shares a meaningful token with the keyword. Short tokens are
  // dropped so common words do not drag in the whole account.
  const keywordTokens = target.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 3);

  const adjacent = [...rollup.entries()]
    .filter(([q]) => q !== target)
    .filter(([q]) => keywordTokens.some((t) => q.includes(t)))
    .map(([q, e]) => toSignal(q, e))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15);

  return {
    existing,
    adjacent,
    layer: {
      id: "gsc",
      status: "ok",
      detail: existing
        ? `already ranking at position ${existing.position} for this query`
        : `${adjacent.length} adjacent queries with impressions; none for the exact keyword`,
    },
  };
}

/**
 * Gather everything known about a keyword before writing.
 *
 * Never throws: a research failure must not fail the generation. The caller
 * gets a bundle whose `layers` explain what is missing, and the prompt builder
 * renders only what is present.
 */
export async function gatherArticleResearch(options: {
  keyword: string;
  locale?: string;
  supabase?: SupabaseClient;
  workspaceId?: string;
}): Promise<ArticleResearch> {
  const { keyword, locale, supabase, workspaceId } = options;
  const loc = getLocale(locale ?? "en");
  const localeParam = {
    languageCode: loc.languageCode,
    locationCode: loc.locationCode,
  };

  const hasDataForSeo = Boolean(
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
  );

  const [serpResult, keywordsResult, gscResult] = await Promise.allSettled([
    hasDataForSeo
      ? fetchAdvancedSerp(keyword, localeParam)
      : Promise.reject(new Error("DataForSEO credentials not configured")),
    hasDataForSeo
      ? fetchRelatedKeywords(keyword, localeParam)
      : Promise.reject(new Error("DataForSEO credentials not configured")),
    supabase && workspaceId
      ? fetchGscSignals(supabase, workspaceId, keyword)
      : Promise.resolve({
          existing: null,
          adjacent: [],
          layer: {
            id: "gsc" as const,
            status: "unavailable" as const,
            detail: "no workspace context supplied",
          },
        }),
  ]);

  const layers: ResearchLayer[] = [];

  const serp: SerpData | null =
    serpResult.status === "fulfilled" ? serpResult.value : null;
  layers.push({
    id: "serp",
    status: serp ? "ok" : hasDataForSeo ? "failed" : "unavailable",
    detail: serp
      ? `${serp.organic.length} ranking pages, ${serp.peopleAlsoAsk.length} People Also Ask entries`
      : serpResult.status === "rejected"
        ? reasonToDetail(serpResult.reason)
        : "no SERP returned",
  });

  const relatedKeywords: RelatedKeyword[] =
    keywordsResult.status === "fulfilled" ? keywordsResult.value : [];
  layers.push({
    id: "related_keywords",
    status:
      keywordsResult.status === "fulfilled"
        ? "ok"
        : hasDataForSeo
          ? "failed"
          : "unavailable",
    detail:
      keywordsResult.status === "fulfilled"
        ? `${relatedKeywords.length} related keywords`
        : reasonToDetail(keywordsResult.reason),
  });

  const gsc =
    gscResult.status === "fulfilled"
      ? gscResult.value
      : {
          existing: null,
          adjacent: [] as GscSignal[],
          layer: {
            id: "gsc" as const,
            status: "failed" as const,
            detail: reasonToDetail(gscResult.reason),
          },
        };
  layers.push(gsc.layer);

  const rawCompetitors: CompetitorPage[] = (serp?.organic ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    domain: r.domain,
    description: r.description,
    wordCount: r.wordCount,
  }));

  // Fill in the word counts the SERP provider does not supply. Only worth the
  // round trips when there are competitors to measure at all.
  const { competitors, layer: lengthLayer } = rawCompetitors.length
    ? await measureCompetitorLengths(rawCompetitors)
    : {
        competitors: rawCompetitors,
        layer: {
          id: "competitor_length" as const,
          status: "unavailable" as const,
          detail: "no competitors to measure",
        },
      };
  layers.push(lengthLayer);

  const { target, basis } = deriveWordCount(competitors);

  return {
    keyword,
    language: loc.label,
    intent: classifyIntent(keyword, loc.languageCode, serp),
    competitors,
    peopleAlsoAsk: serp?.peopleAlsoAsk ?? [],
    relatedKeywords,
    existingPerformance: gsc.existing,
    adjacentQueries: gsc.adjacent,
    recommendedWordCount: target,
    wordCountBasis: basis,
    layers,
  };
}
