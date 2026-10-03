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
  type AiOverview,
} from "./brief-data";
import { hasDataForSEOCredentials } from "./client";
import { classifyIntent, type IntentClassification } from "./intent";
import { getLocale } from "./locales";
import { htmlToMarkdown } from "@/lib/audit/markdown";
import { fetchSite } from "@/lib/audit/lenient-fetch";
import { readGsc, type ReadRow } from "@/lib/gsc/read";
import { figureSentences, mergeSourceFigures, type SourceFigure } from "./source-figures";
import { classOf, FIGURE_CLASSES, type SourceReview } from "./source-classes";
// The one paid step research takes for the sources (a structured call per
// draft). Only `generateArticle` passes `sources`, and it is gated where it
// is called; the entitlement guard (lib/billing/__tests__/entitlement.test.ts)
// follows this import to the spend.
import { classifySources, type AskModel, type SourceCandidate, type SourceOwner, type SpendSink } from "@/lib/seo/source-classify";

export interface ResearchLayer {
  /** `site_facts` is added by lib/content/site-facts.ts, not by `gatherArticleResearch`. */
  id: "serp" | "related_keywords" | "gsc" | "competitor_length" | "site_facts" | "sources";
  /** `ok` loaded, `unavailable` not configured, `failed` configured but errored. */
  status: "ok" | "unavailable" | "failed";
  detail: string;
}

export interface CompetitorPage {
  /** Google's rank for this page, when the SERP reported one. */
  rank: number | null;
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
  /** Original questions and relevance decisions, retained for review. */
  questionSelection?: import("@/lib/ai/article-questions").QuestionSelection;
  /** Google's own AI answer for this query and who it cites. null when the SERP
   *  shows none, which is common and is not a failure. */
  aiOverview: AiOverview | null;
  relatedKeywords: RelatedKeyword[];
  /** Search Console evidence for this exact query, when the site already ranks. */
  existingPerformance: GscSignal | null;
  /** Related queries the site already gets impressions for. */
  adjacentQueries: GscSignal[];
  recommendedWordCount: number;
  wordCountBasis: string;
  layers: ResearchLayer[];
  /**
   * What the business's own pages state that can carry a figure, as the
   * writer was given it (lib/content/site-facts.ts): its statements, the
   * opening of its about page, its section headings. Kept with the research
   * so the fact check - at generation and again at approval - can tell a
   * figure the business states about itself from one nobody sourced
   * (lib/ai/fact-check.ts `statedBySite`). Absent on drafts written before
   * it, and on rewrites, which get no site facts.
   */
  siteStatements?: Array<{ text: string; source: string }>;
  /**
   * Sentences from the ranking pages research fetched that state a figure,
   * with their URLs: what the writer may cite (lib/seo/source-figures.ts).
   * Empty when the pages were read and stated none; absent when no page
   * could be read, and on drafts written before 2026-09-28.
   */
  sourceFigures?: SourceFigure[];
  /**
   * What each site research read IS, against the business: its own, a rival,
   * a business selling the same service, a public source (lib/seo/source-classes.ts).
   * Decides which figures the writer was offered, which links were removed
   * after writing, and which claims the fact check reads as sourced from a
   * rival. Absent on drafts written before 2026-10-01.
   */
  sourceReview?: SourceReview;
  /**
   * What a person has to do or know before publishing this draft, in
   * sentences: no reviewer found for a health article, no figure to cite, a
   * title shortened. Written by lib/content/generate.ts; shown at the top of
   * the editor's research panel.
   */
  reviewNotes?: string[];
  /**
   * Whether this is a health, legal, financial or safety article, who on the
   * site reviews it and what disclaimer it carries (lib/content/trust.ts).
   * Read again at publish for the dateline. Absent before 2026-09-28.
   */
  trust?: import("@/lib/content/trust").ArticleTrust;
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
  languageCode?: string,
): Promise<{ competitors: CompetitorPage[]; layer: ResearchLayer; perPage?: SourceFigure[][] }> {
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
  // The figure-bearing sentences of each page read, in rank order. Taken
  // from the HTML fetched to count words, so citing costs no request.
  const perPage: SourceFigure[][] = targets.map(() => []);

  const results = await Promise.allSettled(
    targets.map(async ({ c, i }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MEASURE_TIMEOUT_MS);
      try {
        const res = await fetchSite(c.url, {
          signal: controller.signal,
          headers: { "User-Agent": UA },
          redirect: "follow",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const { words, markdown } = htmlToMarkdown(html, c.url);
        if (words > 0) measured[i] = { ...c, wordCount: words };
        const slot = targets.findIndex((t) => t.i === i);
        if (slot >= 0 && words > 0) perPage[slot] = figureSentences(markdown, { url: c.url, domain: c.domain }, languageCode);
        return words > 0;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const ok = results.filter((r) => r.status === "fulfilled" && r.value).length;

  return {
    competitors: measured,
    perPage: ok > 0 ? perPage : undefined,
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
 * The figures the writer may cite: those on pages whose site is a public
 * source or the business's own, merged as before. Every other page's figures
 * are held back, with the class that held them, for the fact check.
 */
export function offerableFigures(
  perPage: SourceFigure[][],
  review: SourceReview,
): { figures: SourceFigure[]; heldBack: SourceReview["heldBack"] } {
  const allowed: SourceFigure[][] = [];
  const heldBack: SourceReview["heldBack"] = [];
  for (const page of perPage) {
    if (!page.length) continue;
    const cls = classOf(page[0].url, review);
    if (FIGURE_CLASSES.has(cls)) allowed.push(page);
    else heldBack.push(...page.map((f) => ({ ...f, class: cls })));
  }
  return { figures: mergeSourceFigures(allowed), heldBack };
}

/**
 * Pull Search Console history for this keyword from the synced metrics.
 *
 * Reads `analytics_metrics`, which the analytics cron populates, rather than
 * calling Google directly: the cron already handles token refresh, and article
 * generation should not fail because an access token expired.
 *
 * Query rows only, through lib/gsc/read.ts. The read here used to be
 * `.not("query", "is", null)` with no page filter, which also took the
 * (query, page) rows: every query's clicks and impressions were counted once
 * per shape, so "already ranking" told the writer about twice the traffic the
 * site had. It also stopped at PostgREST's first 1,000 rows of the 90 days.
 *
 * Exported for the db test that pins it to the query shape.
 */
export async function fetchGscSignals(
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

  let rows: ReadRow<"clicks" | "impressions" | "avg_position">[];
  try {
    const gsc = await readGsc(supabase, {
      workspaceId,
      shapes: ["query"],
      since,
      columns: ["clicks", "impressions", "avg_position"],
    });
    rows = gsc.query;
  } catch (error) {
    return {
      existing: null,
      adjacent: [],
      layer: { id: "gsc", status: "failed", detail: error instanceof Error ? error.message : String(error) },
    };
  }

  if (!rows.length) {
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

  for (const row of rows) {
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
  /** The workspace's market can differ from the language's default country. */
  locationCode?: number;
  supabase?: SupabaseClient;
  workspaceId?: string;
  /**
   * Related keywords already bought for this term, so this does not buy them
   * again.
   *
   * `keywords_for_keywords` is billed per task and takes up to twenty seeds,
   * so a run that knows all its keywords upfront - the onboarding fan-out
   * writes seven drafts from one plan - buys the whole week in one task and
   * hands each draft its share. Seven separate drafts each buying their own
   * was $0.63 of a measured $1.929 signup (round4 §4, W2).
   *
   * An empty array is an answer, not an absence: the batched task can
   * legitimately return nothing for a seed, and re-buying it here would undo
   * the saving. `undefined` means nobody looked, and this pays for the lookup.
   */
  relatedKeywords?: RelatedKeyword[];
  /**
   * Whose article this is, so the sites research reads can be classified
   * before any of their figures is offered (lib/seo/source-classify.ts).
   * Without it only code's classes apply - government, academic and
   * encyclopedia sites - and every other page's figures are held back.
   */
  sources?: { owner: SourceOwner; ask?: AskModel; spend?: SpendSink | null };
}): Promise<ArticleResearch> {
  const { keyword, locale, supabase, workspaceId } = options;
  const loc = getLocale(locale ?? "en");
  const localeParam = {
    languageCode: loc.languageCode,
    locationCode: options.locationCode ?? loc.locationCode,
  };

  const hasDataForSeo = hasDataForSEOCredentials();
  const prefetched = options.relatedKeywords;

  const [serpResult, keywordsResult, gscResult] = await Promise.allSettled([
    hasDataForSeo
      ? fetchAdvancedSerp(keyword, localeParam)
      : Promise.reject(new Error("DataForSEO credentials not configured")),
    prefetched
      ? Promise.resolve(prefetched)
      : hasDataForSeo
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
      ? `${serp.organic.length} ranking pages, ${serp.peopleAlsoAsk.length} People Also Ask entries, ` +
        (serp.aiOverview
          ? `AI Overview citing ${serp.aiOverview.citations.length} sources`
          : "no AI Overview")
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
        ? `${relatedKeywords.length} related keywords` +
          // Say where they came from. A reviewer reading "3 related keywords"
          // on a fan-out draft should be able to tell a thin answer from a
          // share of one lookup, not have to guess which.
          (prefetched ? ", from this run's shared lookup" : "")
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
    rank: r.rank,
    title: r.title,
    url: r.url,
    domain: r.domain,
    description: r.description,
    wordCount: r.wordCount,
  }));

  // Who each site is, asked once while the pages are fetched: the results
  // page's own fields are all it reads, so it waits on nothing.
  const owner: SourceOwner = options.sources?.owner ?? { ownDomain: null, rivals: [], business: null };
  const candidates: SourceCandidate[] = [
    ...rawCompetitors.map((c) => ({ url: c.url, title: c.title, snippet: c.description })),
    ...(serp?.aiOverview?.citations ?? []).map((c) => ({ url: c.url, title: c.title, snippet: null })),
  ];
  const classesPending = candidates.length
    ? classifySources(candidates, owner, { ask: options.sources?.ask, spend: options.sources?.spend })
    : Promise.resolve({ classes: [], model: "skipped" as const });

  // Fill in the word counts the SERP provider does not supply. Only worth the
  // round trips when there are competitors to measure at all.
  const { competitors, layer: lengthLayer, perPage } = rawCompetitors.length
    ? await measureCompetitorLengths(rawCompetitors, localeParam.languageCode)
    : {
        competitors: rawCompetitors,
        perPage: undefined,
        layer: {
          id: "competitor_length" as const,
          status: "unavailable" as const,
          detail: "no competitors to measure",
        },
      };
  const classified = await classesPending;
  const sourceReview: SourceReview = {
    ownDomain: owner.ownDomain,
    rivals: owner.rivals,
    classes: classified.classes,
    model: classified.model,
    heldBack: [],
  };
  let sourceFigures: SourceFigure[] | undefined;
  if (perPage) {
    const offered = offerableFigures(perPage, sourceReview);
    sourceFigures = offered.figures;
    sourceReview.heldBack = offered.heldBack;
    lengthLayer.detail +=
      `; ${sourceFigures.length} sentence${sourceFigures.length === 1 ? "" : "s"} with a figure kept for the writer to cite` +
      (offered.heldBack.length ? `, ${offered.heldBack.length} held back from sites that are not a public source` : "");
  }
  layers.push(lengthLayer);
  if (candidates.length) {
    const count = (cls: string) => sourceReview.classes.filter((c) => c.class === cls).length;
    const blocked = count("same_service") + count("named_rival");
    layers.push({
      id: "sources",
      status: classified.model === "failed" ? "failed" : classified.model === "unavailable" ? "unavailable" : "ok",
      detail:
        `${sourceReview.classes.length} sites read: ${blocked} sell${blocked === 1 ? "s" : ""} what this business sells, ` +
        `${count("information")} public source${count("information") === 1 ? "" : "s"}, ${count("unclassified")} unclassified` +
        (classified.model === "failed" ? "; the classifier gave no usable answer" : classified.model === "unavailable" ? "; no model or business description to classify with" : ""),
    });
  }

  const { target, basis } = deriveWordCount(competitors);

  return {
    keyword,
    language: loc.label,
    intent: classifyIntent(keyword, loc.languageCode, serp),
    competitors,
    peopleAlsoAsk: serp?.peopleAlsoAsk ?? [],
    aiOverview: serp?.aiOverview ?? null,
    relatedKeywords,
    existingPerformance: gsc.existing,
    adjacentQueries: gsc.adjacent,
    recommendedWordCount: target,
    wordCountBasis: basis,
    layers,
    ...(sourceFigures ? { sourceFigures } : {}),
    // Whenever the owner is known, even with no results page: the rivals the
    // owner named are code's to block, and the scrub and the fact check
    // need them listed when the search itself failed.
    ...(candidates.length || options.sources ? { sourceReview } : {}),
  };
}
