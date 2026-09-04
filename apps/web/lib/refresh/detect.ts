// ---------------------------------------------------------------------------
// Refresh detectors: which pages would a rewrite help, and why
// ---------------------------------------------------------------------------
//
// Pure functions over rows the product already stores. Nothing here calls an
// API: the evidence is Search Console rows synced nightly into
// `analytics_metrics`, SERP checks in `keyword_rankings`, and the page facts
// in `site_pages` and `articles`. A detector that needed a new data source
// would be a different feature.
//
// The join between "a page" and "a query" is the page's target keyword: the
// keyword an article was written for, or the term `site_pages` inferred for a
// page the site already had. Search Console is stored per query and per page
// but not per query-and-page, so this is the honest link available. It is
// also why every candidate carries its evidence: the reviewer can see which
// query the verdict rests on and disagree.
//
// Rule 5 throughout: a field that was not measured is null, never 0.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tiptapToHtml } from "@/lib/cms/html";
import type { Detection, Evidence, Opportunity } from "./types";

// ── Inputs ──────────────────────────────────────────────────────────────────

/** One query's Search Console totals over a window. */
export interface QueryStats {
  query: string;
  clicks: number;
  impressions: number;
  /** clicks / impressions, 0..1. */
  ctr: number;
  /** Impression-weighted average position. */
  position: number;
}

/** One page as the detectors see it. */
export interface PageInput {
  url: string;
  site_page_id: string | null;
  article_id: string | null;
  /** The query this page targets. Null means the detectors have nothing to join on. */
  keyword: string | null;
  word_count: number | null;
  /**
   * H1-H3 text, when the markup is available. Null when it is not (a
   * site page we only stored facts about), in which case the heading rule
   * does not fire: "no heading matches" is not knowable without headings.
   */
  headings: string[] | null;
  /**
   * SERP-check positions from `keyword_rankings`, when tracked. A second
   * source for the position history behind `declining`.
   */
  serp?: { position: number | null; prev_position: number | null } | null;
}

export interface DetectInput {
  page: PageInput;
  /** Query totals for the last 28 days, keyed by lower-cased query. */
  current: ReadonlyMap<string, QueryStats>;
  /** Query totals for the 28 days before that. */
  previous: ReadonlyMap<string, QueryStats>;
}

// ── Thresholds ──────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  /** almost_there: position band and the impressions that make it worth it. */
  almostThereMin: 6,
  almostThereMax: 15,
  almostThereImpressions: 100,
  /** ctr_gap: top positions, and how far under the curve counts as a gap. */
  ctrGapMaxPosition: 5,
  ctrGapShortfall: 0.4,
  /** Below this many impressions a CTR is noise, not a measurement. */
  ctrGapMinImpressions: 50,
  /** declining: places lost, or share of clicks lost. */
  decliningPositions: 3,
  decliningClicksShare: 0.3,
  /** Fewer previous clicks than this and a 30% drop is one person. */
  decliningMinPrevClicks: 10,
  /** content_gap / thin word counts. */
  contentGapWords: 800,
  thinWords: 600,
} as const;

/**
 * Click-through rate a position usually earns, position 1 to 10.
 *
 * A baseline, not a measurement of this site: the point is to notice a page
 * at #2 earning what #8 earns, and the exact numbers matter less than the
 * shape. Fractional positions interpolate; anything past ten is flat.
 */
const EXPECTED_CTR = [0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.035, 0.03, 0.025];

export function expectedCtr(position: number): number {
  if (!Number.isFinite(position) || position <= 1) return EXPECTED_CTR[0];
  if (position >= EXPECTED_CTR.length) return EXPECTED_CTR[EXPECTED_CTR.length - 1];
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  if (lo === hi) return EXPECTED_CTR[lo - 1];
  const t = position - lo;
  return EXPECTED_CTR[lo - 1] * (1 - t) + EXPECTED_CTR[hi - 1] * t;
}

// ── Detectors ───────────────────────────────────────────────────────────────

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/** Words worth matching in a query: no stopwords, no one-letter tokens. */
const QUERY_STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "with", "is",
  "are", "how", "what", "why", "when", "do", "does", "vs", "il", "la", "le",
  "di", "per", "come", "cosa", "der", "die", "das", "und", "de", "el", "los",
]);

export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !QUERY_STOPWORDS.has(w));
}

/**
 * Whether any heading addresses the query: every significant query term
 * appears in one heading. Exported so the brief can say which heading is
 * missing in the same words the detector used.
 */
export function headingMatchesQuery(headings: string[], query: string): boolean {
  const terms = queryTerms(query);
  if (!terms.length) return true;
  return headings.some((h) => {
    const text = h.toLowerCase();
    return terms.every((t) => text.includes(t));
  });
}

/**
 * Run every detector against one page.
 *
 * Returns zero or more detections; a page can be both `almost_there` and
 * `content_gap`, and the candidate table keeps them apart so a reviewer can
 * dismiss one and act on the other.
 */
export function detectOpportunities({ page, current, previous }: DetectInput): Detection[] {
  const key = page.keyword?.trim().toLowerCase() ?? "";
  const now = key ? current.get(key) ?? null : null;
  const then = key ? previous.get(key) ?? null : null;

  // Position: Search Console first, SERP checks as the fallback.
  const position = now?.position ?? page.serp?.position ?? null;
  const prevPosition = then?.position ?? page.serp?.prev_position ?? null;

  const base: Evidence = {
    query: page.keyword ?? null,
    position: position === null ? null : round(position),
    prev_position: prevPosition === null ? null : round(prevPosition),
    clicks: now?.clicks ?? null,
    prev_clicks: then?.clicks ?? null,
    impressions: now?.impressions ?? null,
    ctr: now ? round(now.ctr, 4) : null,
    expected_ctr: null,
    word_count: page.word_count ?? null,
  };

  const out: Detection[] = [];
  const add = (opportunity: Opportunity, extra: Partial<Evidence> = {}) =>
    out.push({ opportunity, evidence: { ...base, ...extra } });

  // almost_there: page two, with demand.
  if (
    now &&
    now.position >= THRESHOLDS.almostThereMin &&
    now.position <= THRESHOLDS.almostThereMax &&
    now.impressions >= THRESHOLDS.almostThereImpressions
  ) {
    add("almost_there");
  }

  // ctr_gap: ranks well, earns badly.
  if (now && now.position <= THRESHOLDS.ctrGapMaxPosition && now.impressions >= THRESHOLDS.ctrGapMinImpressions) {
    const expected = expectedCtr(now.position);
    if (now.ctr < expected * (1 - THRESHOLDS.ctrGapShortfall)) {
      add("ctr_gap", { expected_ctr: round(expected, 4) });
    }
  }

  // declining: worse than the previous window, by rank or by clicks.
  const lostPlaces =
    position !== null && prevPosition !== null && position - prevPosition >= THRESHOLDS.decliningPositions;
  const lostClicks =
    now !== null &&
    then !== null &&
    then.clicks >= THRESHOLDS.decliningMinPrevClicks &&
    now.clicks <= then.clicks * (1 - THRESHOLDS.decliningClicksShare);
  if (lostPlaces || lostClicks) add("declining");

  // thin: short and still seen.
  const words = page.word_count;
  const seen = (now?.impressions ?? 0) > 0;
  const thin = words !== null && words < THRESHOLDS.thinWords && seen;
  if (thin) add("thin");

  // content_gap: ranks for the query but the page does not carry it. Not
  // raised on a page `thin` already covers - one verdict per cause.
  const ranks = position !== null && seen;
  if (ranks && !thin) {
    const short = words !== null && words < THRESHOLDS.contentGapWords;
    const missingHeading =
      page.headings !== null && key !== "" && !headingMatchesQuery(page.headings, page.keyword!);
    if (short || missingHeading) add("content_gap");
  }

  return out;
}

// ── Aggregation over stored rows ────────────────────────────────────────────

/** The columns this reads from `analytics_metrics`. */
export interface MetricRow {
  metric_date: string;
  query: string | null;
  page_url: string | null;
  article_id: string | null;
  clicks: number | null;
  impressions: number | null;
  avg_position: number | string | null;
}

/** Total per-day query rows into one QueryStats per query. */
export function aggregateQueries(rows: readonly MetricRow[]): Map<string, QueryStats> {
  const acc = new Map<string, { clicks: number; impressions: number; posWeight: number; weight: number }>();
  for (const r of rows) {
    // Query rows only. Page rows carry a URL and no query.
    if (!r.query || r.page_url) continue;
    const key = r.query.trim().toLowerCase();
    const a = acc.get(key) ?? { clicks: 0, impressions: 0, posWeight: 0, weight: 0 };
    const imp = r.impressions ?? 0;
    a.clicks += r.clicks ?? 0;
    a.impressions += imp;
    const pos = r.avg_position === null ? null : Number(r.avg_position);
    if (pos !== null && Number.isFinite(pos) && pos > 0) {
      // Weighted by impressions so a day with one impression at #40 does
      // not drag a month at #6 to #23. A day with no impressions but a
      // position still counts once.
      const w = Math.max(imp, 1);
      a.posWeight += pos * w;
      a.weight += w;
    }
    acc.set(key, a);
  }
  const out = new Map<string, QueryStats>();
  for (const [query, a] of acc) {
    if (a.weight === 0) continue; // never ranked: not a query we can judge
    out.set(query, {
      query,
      clicks: a.clicks,
      impressions: a.impressions,
      ctr: a.impressions > 0 ? a.clicks / a.impressions : 0,
      position: a.posWeight / a.weight,
    });
  }
  return out;
}

/** Split rows into the last 28 days and the 28 before, by `metric_date`. */
export function splitWindows<T extends { metric_date: string }>(
  rows: readonly T[],
  now: Date = new Date(),
  days = 28,
): { current: T[]; previous: T[] } {
  const end = now.getTime();
  const cut = end - days * 86_400_000;
  const start = cut - days * 86_400_000;
  const current: T[] = [];
  const previous: T[] = [];
  for (const r of rows) {
    const t = Date.parse(r.metric_date);
    if (!Number.isFinite(t)) continue;
    if (t >= cut && t <= end) current.push(r);
    else if (t >= start && t < cut) previous.push(r);
  }
  return { current, previous };
}

/** H1-H3 text out of an HTML fragment, for the heading rule. */
export function headingsOf(html: string): string[] {
  return [...html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) =>
    m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
  );
}

// ── The workspace pass ──────────────────────────────────────────────────────

export type AnalyzeResult =
  | { reason: "gsc_not_connected" }
  | { reason: "ok"; pages: number; created: number; refreshed: number };

const normUrl = (u: string) => {
  try {
    const url = new URL(u);
    return (url.host + url.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.replace(/\/+$/, "").toLowerCase();
  }
};

/**
 * Detect across one workspace and upsert the candidates.
 *
 * Never duplicates an open candidate: an existing (url, opportunity) row that
 * is not dismissed gets its evidence refreshed and keeps its id, brief and
 * any task pointing at it. Dismissed rows are left alone; if the numbers still
 * say so next week, a new row is raised.
 *
 * Does nothing without Search Console. Every detector reads its rows, and a
 * page with no impressions data is not "getting no impressions", it is
 * unmeasured.
 */
export async function analyzeWorkspace(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { now?: Date } = {},
): Promise<AnalyzeResult> {
  const now = opts.now ?? new Date();

  const { data: gsc } = await supabase
    .from("workspace_integrations")
    .select("id, tokens")
    .eq("workspace_id", workspaceId)
    .eq("integration_id", "gsc")
    .not("tokens", "is", null)
    .limit(1);
  if (!gsc?.length) return { reason: "gsc_not_connected" };

  const since = new Date(now.getTime() - 56 * 86_400_000).toISOString().slice(0, 10);
  const { data: metricRows } = await supabase
    .from("analytics_metrics")
    .select("metric_date, query, page_url, article_id, clicks, impressions, avg_position")
    .eq("workspace_id", workspaceId)
    .eq("source", "gsc")
    .gte("metric_date", since);
  const windows = splitWindows((metricRows ?? []) as MetricRow[], now);
  const current = aggregateQueries(windows.current);
  const previous = aggregateQueries(windows.previous);

  const serp = await loadSerpHistory(supabase, workspaceId, now);

  const [{ data: articles }, { data: sitePages }] = await Promise.all([
    supabase
      .from("articles")
      .select("id, keyword, word_count, content, published_url")
      .eq("workspace_id", workspaceId)
      .eq("status", "live")
      .not("published_url", "is", null),
    supabase
      .from("site_pages")
      .select("id, url, keyword, word_count")
      .eq("workspace_id", workspaceId)
      .eq("page_type", "article")
      .not("keyword", "is", null),
  ]);

  const pages: PageInput[] = [];
  const seen = new Set<string>();
  for (const a of articles ?? []) {
    const url = a.published_url as string;
    seen.add(normUrl(url));
    const html = a.content ? tiptapToHtml(a.content as Record<string, unknown>) : "";
    const keyword = (a.keyword as string | null) ?? null;
    pages.push({
      url,
      article_id: a.id as string,
      site_page_id: null,
      keyword,
      word_count: (a.word_count as number | null) ?? null,
      headings: html ? headingsOf(html) : null,
      serp: keyword ? serp.get(keyword.toLowerCase()) ?? null : null,
    });
  }
  for (const p of sitePages ?? []) {
    const url = p.url as string;
    const key = normUrl(url);
    if (seen.has(key)) {
      // A page we also wrote: the article row is the richer source, so the
      // site_page id rides along on that candidate instead of a second one.
      const own = pages.find((pg) => normUrl(pg.url) === key);
      if (own) own.site_page_id = p.id as string;
      continue;
    }
    const keyword = (p.keyword as string | null) ?? null;
    pages.push({
      url,
      article_id: null,
      site_page_id: p.id as string,
      keyword,
      word_count: (p.word_count as number | null) ?? null,
      headings: null,
      serp: keyword ? serp.get(keyword.toLowerCase()) ?? null : null,
    });
  }

  const { data: openRows } = await supabase
    .from("refresh_candidates")
    .select("id, url, opportunity")
    .eq("workspace_id", workspaceId)
    .is("dismissed_at", null);
  const open = new Map((openRows ?? []).map((r) => [`${normUrl(r.url as string)}|${r.opportunity}`, r.id as string]));

  let created = 0;
  let refreshed = 0;
  const inserts: Record<string, unknown>[] = [];
  for (const page of pages) {
    for (const d of detectOpportunities({ page, current, previous })) {
      const existing = open.get(`${normUrl(page.url)}|${d.opportunity}`);
      if (existing) {
        await supabase
          .from("refresh_candidates")
          .update({ evidence: d.evidence, site_page_id: page.site_page_id, article_id: page.article_id })
          .eq("id", existing);
        refreshed++;
      } else {
        inserts.push({
          workspace_id: workspaceId,
          site_page_id: page.site_page_id,
          article_id: page.article_id,
          url: page.url,
          opportunity: d.opportunity,
          evidence: d.evidence,
        });
      }
    }
  }
  for (let i = 0; i < inserts.length; i += 50) {
    const { error } = await supabase.from("refresh_candidates").insert(inserts.slice(i, i + 50));
    if (error) throw new Error(`refresh_candidates insert: ${error.message}`);
    created += Math.min(50, inserts.length - i);
  }

  await supabase
    .from("workspaces")
    .update({ refresh_last_analyzed_at: now.toISOString() })
    .eq("id", workspaceId);

  return { reason: "ok", pages: pages.length, created, refreshed };
}

/**
 * Latest SERP-check position per keyword, and the one nearest 28 days ago.
 * Empty when nothing is tracked, which the detectors read as "no second
 * source", not as "no movement".
 */
async function loadSerpHistory(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<Map<string, { position: number | null; prev_position: number | null }>> {
  const out = new Map<string, { position: number | null; prev_position: number | null }>();
  const { data: keywords } = await supabase
    .from("keywords")
    .select("id, term")
    .eq("workspace_id", workspaceId);
  if (!keywords?.length) return out;

  const since = new Date(now.getTime() - 60 * 86_400_000).toISOString();
  const { data: rankings } = await supabase
    .from("keyword_rankings")
    .select("keyword_id, position, checked_at")
    .in("keyword_id", keywords.map((k) => k.id))
    .gte("checked_at", since)
    .order("checked_at", { ascending: false });
  if (!rankings?.length) return out;

  const termById = new Map(keywords.map((k) => [k.id as string, (k.term as string).toLowerCase()]));
  const cut = now.getTime() - 28 * 86_400_000;
  const byKeyword = new Map<string, { position: number | null; checked_at: string }[]>();
  for (const r of rankings) {
    const list = byKeyword.get(r.keyword_id as string) ?? [];
    list.push({ position: r.position as number | null, checked_at: r.checked_at as string });
    byKeyword.set(r.keyword_id as string, list);
  }
  for (const [id, list] of byKeyword) {
    const term = termById.get(id);
    if (!term) continue;
    const latest = list[0];
    // The newest check on or before the cut, i.e. what it was a window ago.
    const older = list.find((r) => Date.parse(r.checked_at) <= cut) ?? null;
    out.set(term, { position: latest?.position ?? null, prev_position: older?.position ?? null });
  }
  return out;
}
