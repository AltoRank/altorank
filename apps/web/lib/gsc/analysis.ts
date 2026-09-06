// ---------------------------------------------------------------------------
// Arithmetic over Search Console rows we already hold
// ---------------------------------------------------------------------------
//
// Everything here is pure: rows in, numbers out, the clock passed as an
// argument. The nightly sync (lib/google/sync.ts) writes `analytics_metrics`
// rows in four shapes, told apart by which of `query` and `page_url` are set:
//
//   total       neither      the property's own daily total
//   query       query only   one row per query, per day
//   page        page only    one row per page, per day
//   query_page  both         one row per (query, page), per day
//
// Each shape answers one question and must never be summed with another: the
// same click appears once in every shape, so adding two of them together
// doubles it. `dailySeries` reads totals (falling back to query rows for days
// synced before totals existed), `topPages` reads page rows, `cannibalization`
// reads query_page rows and `queryOpportunities` reads query rows.
//
// Every number is measured or null. A page with no rows in the previous window
// has `prevClicks: null` when nothing at all was synced for that window, and 0
// when the window was synced and Google reported nothing for it - Search
// Console omits zero rows, so absence inside a synced window is a measured
// zero, and absence of the whole window is not.

export type GscRow = {
  metric_date: string;
  clicks: number | null;
  impressions: number | null;
  avg_position: number | null;
  page_url: string | null;
  query: string | null;
  article_id?: string | null;
};

export const WINDOW_DAYS = 28;

export type RowShape = "total" | "query" | "page" | "query_page";

export function rowShape(r: Pick<GscRow, "query" | "page_url">): RowShape {
  if (r.query && r.page_url) return "query_page";
  if (r.query) return "query";
  if (r.page_url) return "page";
  return "total";
}

/** ISO date, `n` days before `today` (UTC). */
export function isoDaysAgo(today: Date, n: number): string {
  return new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
}

export type DateWindow = { start: string; end: string };

/**
 * The current window ends yesterday: today has not happened in Search
 * Console yet, and counting it as a day of zero would bend every average.
 * The previous window is the same length, immediately before.
 */
export function windows(today: Date, days = WINDOW_DAYS): { current: DateWindow; previous: DateWindow; since: string } {
  const current = { start: isoDaysAgo(today, days), end: isoDaysAgo(today, 1) };
  const previous = { start: isoDaysAgo(today, days * 2), end: isoDaysAgo(today, days + 1) };
  return { current, previous, since: previous.start };
}

export function inWindow(date: string, w: DateWindow): boolean {
  return date >= w.start && date <= w.end;
}

export type DayPoint = { date: string; clicks: number; impressions: number };

const n = (v: number | null | undefined) => v ?? 0;

/**
 * One point per day for one window. Totals when the day has a total row;
 * otherwise the sum of that day's query rows, which is what the sync stored
 * before it fetched totals. Query rows undercount slightly (Google withholds
 * anonymised queries from that dimension) so a total row wins when both exist.
 */
function seriesFor(rows: GscRow[], w: DateWindow): DayPoint[] {
  const totals = new Map<string, DayPoint>();
  const fromQueries = new Map<string, DayPoint>();
  for (const r of rows) {
    if (!inWindow(r.metric_date, w)) continue;
    const shape = rowShape(r);
    const target = shape === "total" ? totals : shape === "query" ? fromQueries : null;
    if (!target) continue;
    const p = target.get(r.metric_date) ?? { date: r.metric_date, clicks: 0, impressions: 0 };
    p.clicks += n(r.clicks);
    p.impressions += n(r.impressions);
    target.set(r.metric_date, p);
  }
  const out: DayPoint[] = [];
  for (let d = w.start; d <= w.end; d = isoDaysAgo(new Date(`${d}T00:00:00Z`), -1)) {
    out.push(totals.get(d) ?? fromQueries.get(d) ?? { date: d, clicks: 0, impressions: 0 });
  }
  return out;
}

export type Comparison = {
  current: number;
  /** Null when the previous window was never synced. */
  previous: number | null;
  /** Percent change, or null when there is no baseline to compare against. */
  changePct: number | null;
};

function compare(current: number, previous: number | null): Comparison {
  return {
    current,
    previous,
    // No baseline means no percentage. "+100%" against zero is a number that
    // sounds like growth and describes nothing.
    changePct: previous !== null && previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null,
  };
}

export type SearchPerformance = {
  days: number;
  current: DayPoint[];
  previous: DayPoint[];
  clicks: Comparison;
  impressions: Comparison;
  /** Any Search Console row at all, in either window. */
  hasData: boolean;
  /** Something was synced for the previous window, so deltas mean something. */
  previousMeasured: boolean;
  /** A click in either window. False with hasData true is a measured zero. */
  hasClicks: boolean;
};

/** Any row of any shape dated inside the window: the window was synced. */
export function windowMeasured(rows: GscRow[], w: DateWindow): boolean {
  return rows.some((r) => inWindow(r.metric_date, w));
}

export function searchPerformance(rows: GscRow[], today: Date, days = WINDOW_DAYS): SearchPerformance {
  const w = windows(today, days);
  const current = seriesFor(rows, w.current);
  const previous = seriesFor(rows, w.previous);
  const sum = (pts: DayPoint[], k: "clicks" | "impressions") => pts.reduce((s, p) => s + p[k], 0);
  const previousMeasured = windowMeasured(rows, w.previous);
  const clicks = compare(sum(current, "clicks"), previousMeasured ? sum(previous, "clicks") : null);
  const impressions = compare(sum(current, "impressions"), previousMeasured ? sum(previous, "impressions") : null);
  return {
    days,
    current,
    previous,
    clicks,
    impressions,
    hasData: windowMeasured(rows, w.current) || previousMeasured,
    previousMeasured,
    hasClicks: clicks.current > 0 || (clicks.previous ?? 0) > 0,
  };
}

// ---------------------------------------------------------------------------
// Aggregation shared by pages, queries and query/page pairs
// ---------------------------------------------------------------------------

type Agg = { clicks: number; impressions: number; posWeight: number; posImpr: number };

function addTo(agg: Agg, r: GscRow) {
  agg.clicks += n(r.clicks);
  agg.impressions += n(r.impressions);
  // Position averaged over impressions, which is what Search Console itself
  // does: a day with one impression at position 3 must not pull a month at
  // position 40 toward 20.
  if (r.avg_position !== null && r.avg_position !== undefined && n(r.impressions) > 0) {
    agg.posWeight += r.avg_position * n(r.impressions);
    agg.posImpr += n(r.impressions);
  }
}

const newAgg = (): Agg => ({ clicks: 0, impressions: 0, posWeight: 0, posImpr: 0 });
const position = (a: Agg): number | null => (a.posImpr > 0 ? Math.round((a.posWeight / a.posImpr) * 10) / 10 : null);
const ctr = (a: Agg): number | null => (a.impressions > 0 ? Math.round((a.clicks / a.impressions) * 10000) / 10000 : null);

/** Lower-case, no scheme, no trailing slash: how two spellings of one page meet. */
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    return (url.host + url.pathname).replace(/^www\./, "").replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "").toLowerCase();
  }
}

export type PageStat = {
  url: string;
  /** Set when the page is an article of ours, so the row can link to the editor. */
  articleId: string | null;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  /** Null when the previous window was never synced. */
  prevClicks: number | null;
  clicksDelta: number | null;
};

/** Pages by clicks over the current window, with the previous window beside each. */
export function topPages(rows: GscRow[], today: Date, days = WINDOW_DAYS, limit = 8): PageStat[] {
  const w = windows(today, days);
  const previousMeasured = windowMeasured(rows, w.previous);
  const cur = new Map<string, Agg & { url: string; articleId: string | null }>();
  const prev = new Map<string, number>();
  for (const r of rows) {
    if (rowShape(r) !== "page") continue;
    const key = normalizeUrl(r.page_url as string);
    if (inWindow(r.metric_date, w.current)) {
      const a = cur.get(key) ?? { ...newAgg(), url: r.page_url as string, articleId: null };
      addTo(a, r);
      if (r.article_id) a.articleId = r.article_id;
      cur.set(key, a);
    } else if (inWindow(r.metric_date, w.previous)) {
      prev.set(key, (prev.get(key) ?? 0) + n(r.clicks));
    }
  }
  return [...cur.entries()]
    .map(([key, a]) => {
      const prevClicks = previousMeasured ? (prev.get(key) ?? 0) : null;
      return {
        url: a.url,
        articleId: a.articleId,
        clicks: a.clicks,
        impressions: a.impressions,
        ctr: ctr(a),
        position: position(a),
        prevClicks,
        clicksDelta: prevClicks === null ? null : a.clicks - prevClicks,
      };
    })
    .sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions)
    .slice(0, limit);
}

export type QueryStat = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
};

/** Per-query totals over the current window, keyed by the lower-cased query. */
export function queryStats(rows: GscRow[], today: Date, days = WINDOW_DAYS): Map<string, QueryStat> {
  const w = windows(today, days);
  const aggs = new Map<string, Agg & { query: string }>();
  for (const r of rows) {
    if (rowShape(r) !== "query" || !inWindow(r.metric_date, w.current)) continue;
    const key = (r.query as string).trim().toLowerCase();
    const a = aggs.get(key) ?? { ...newAgg(), query: r.query as string };
    addTo(a, r);
    aggs.set(key, a);
  }
  const out = new Map<string, QueryStat>();
  for (const [key, a] of aggs) {
    out.set(key, { query: a.query, clicks: a.clicks, impressions: a.impressions, ctr: ctr(a), position: position(a) });
  }
  return out;
}

/** Position bands where the next revision is worth more than a new article. */
export const OPPORTUNITY_MIN_POSITION = 4;
export const OPPORTUNITY_MAX_POSITION = 15;

/**
 * Queries one push from page one: shown, not yet clicked much, sitting in
 * positions 4-15. Same signal `lib/seo/recommendations.ts` weights as
 * striking distance; this is the per-query view of it.
 */
export function queryOpportunities(rows: GscRow[], today: Date, days = WINDOW_DAYS, limit = 10): QueryStat[] {
  return [...queryStats(rows, today, days).values()]
    .filter((q) => q.position !== null && q.position >= OPPORTUNITY_MIN_POSITION && q.position <= OPPORTUNITY_MAX_POSITION && q.impressions > 0)
    .sort((x, y) => y.impressions - x.impressions || (x.position ?? 99) - (y.position ?? 99))
    .slice(0, limit);
}

export type CannibalPage = {
  url: string;
  articleId: string | null;
  clicks: number;
  impressions: number;
  position: number | null;
};

export type CannibalSuggestion = {
  url: string;
  action: "merge" | "differentiate";
  /** The suggestion, in words. Nothing here acts on it. */
  text: string;
};

export type Cannibalization = {
  query: string;
  clicks: number;
  impressions: number;
  pages: CannibalPage[];
  /** The page Google already prefers for this query. */
  winner: CannibalPage;
  suggestions: CannibalSuggestion[];
};

/**
 * A loser earning this share of the winner's clicks or less is not competing,
 * it is diluting; fold it in. Above it, both pages have an audience, so the
 * fix is to give them different jobs.
 */
const MERGE_SHARE = 0.2;

/**
 * Queries where two or more of our pages rank. Google picks one page per
 * query per result set, so two pages splitting a query split its position
 * history and its links. The output names the pages and a fix in words;
 * merging or rewriting is a person's decision.
 */
export function cannibalization(
  rows: GscRow[],
  today: Date,
  days = WINDOW_DAYS,
  opts: { minImpressions?: number; limit?: number } = {},
): Cannibalization[] {
  const minImpressions = opts.minImpressions ?? 10;
  const limit = opts.limit ?? 10;
  const w = windows(today, days);
  const byQuery = new Map<string, { query: string; pages: Map<string, Agg & { url: string; articleId: string | null }> }>();
  for (const r of rows) {
    if (rowShape(r) !== "query_page" || !inWindow(r.metric_date, w.current)) continue;
    const qKey = (r.query as string).trim().toLowerCase();
    const q = byQuery.get(qKey) ?? { query: r.query as string, pages: new Map() };
    const pKey = normalizeUrl(r.page_url as string);
    const p = q.pages.get(pKey) ?? { ...newAgg(), url: r.page_url as string, articleId: null };
    addTo(p, r);
    if (r.article_id) p.articleId = r.article_id;
    q.pages.set(pKey, p);
    byQuery.set(qKey, q);
  }

  const out: Cannibalization[] = [];
  for (const q of byQuery.values()) {
    const pages: CannibalPage[] = [...q.pages.values()]
      .filter((p) => p.impressions > 0)
      .map((p) => ({ url: p.url, articleId: p.articleId, clicks: p.clicks, impressions: p.impressions, position: position(p) }))
      // Most clicks first; then the better (lower) position; then more impressions.
      .sort((x, y) => y.clicks - x.clicks || (x.position ?? 999) - (y.position ?? 999) || y.impressions - x.impressions);
    if (pages.length < 2) continue;
    const impressions = pages.reduce((s, p) => s + p.impressions, 0);
    if (impressions < minImpressions) continue;
    const winner = pages[0];
    const suggestions: CannibalSuggestion[] = pages.slice(1).map((loser) => {
      const merge = winner.clicks > 0 && loser.clicks <= winner.clicks * MERGE_SHARE;
      return merge
        ? { url: loser.url, action: "merge", text: `Merge ${shortUrl(loser.url)} into ${shortUrl(winner.url)}: it earns ${loser.clicks} of ${winner.clicks + loser.clicks} clicks for this query.` }
        : { url: loser.url, action: "differentiate", text: `Differentiate ${shortUrl(loser.url)} from ${shortUrl(winner.url)}: both earn clicks, so give them different questions to answer.` };
    });
    out.push({ query: q.query, clicks: pages.reduce((s, p) => s + p.clicks, 0), impressions, pages, winner, suggestions });
  }
  return out.sort((x, y) => y.impressions - x.impressions).slice(0, limit);
}

/** The path, for prose: nobody needs the scheme in a sentence. */
export function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.pathname === "/" ? url.host : url.pathname.replace(/\/+$/, "");
  } catch {
    return u;
  }
}

// ---------------------------------------------------------------------------
// Index coverage
// ---------------------------------------------------------------------------

export type CoverageBucket = "indexed" | "not_indexed" | "unknown";

/** What a URL Inspection call said; lib/google/inspection.ts builds these. */
export type InspectionVerdictLike = { verdict: string | null } | null | undefined;

/**
 * Where a page stands, from the two things we can actually know: what Google
 * said when asked (URL Inspection), and whether Google served the page in
 * search during the window (a page with impressions is in the index by
 * definition). A URL we merely fetched with a 200 is not indexed for having
 * responded, so `site_pages.status` never promotes a page here.
 *
 * Inspection wins when present: it is Google's direct answer about this URL.
 */
export function coverageBucket(inspection: InspectionVerdictLike, servedInSearch: boolean): CoverageBucket {
  if (inspection?.verdict) {
    if (inspection.verdict === "PASS") return "indexed";
    // NEUTRAL is Google's "excluded" (noindex, canonical elsewhere, crawled
    // and not indexed); FAIL is an error. Neither URL is in the index.
    // PARTIAL and VERDICT_UNSPECIFIED say nothing about the index, so they
    // fall through to the search evidence.
    if (inspection.verdict === "FAIL" || inspection.verdict === "NEUTRAL") return "not_indexed";
  }
  return servedInSearch ? "indexed" : "unknown";
}

export type KnownPage = {
  url: string;
  inspection?: InspectionVerdictLike;
};

export type IndexCoverage = {
  total: number;
  indexed: number;
  notIndexed: number;
  /** Pages we know exist and have no measurement for. A real bucket, not a gap. */
  unknown: number;
  /** How many of the measured buckets came from each source. */
  byInspection: number;
  bySearch: number;
};

/** URLs Google served in the current window, normalised, from page rows. */
export function servedUrls(rows: GscRow[], today: Date, days = WINDOW_DAYS): Set<string> {
  const w = windows(today, days);
  const out = new Set<string>();
  for (const r of rows) {
    if (rowShape(r) !== "page" || !inWindow(r.metric_date, w.current) || n(r.impressions) <= 0) continue;
    out.add(normalizeUrl(r.page_url as string));
  }
  return out;
}

export function indexCoverage(known: KnownPage[], served: Set<string>): IndexCoverage {
  const seen = new Set<string>();
  const out: IndexCoverage = { total: 0, indexed: 0, notIndexed: 0, unknown: 0, byInspection: 0, bySearch: 0 };
  for (const page of known) {
    const key = normalizeUrl(page.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.total++;
    const inSearch = served.has(key);
    const bucket = coverageBucket(page.inspection, inSearch);
    if (bucket === "indexed") out.indexed++;
    else if (bucket === "not_indexed") out.notIndexed++;
    else out.unknown++;
    if (bucket !== "unknown") {
      if (page.inspection?.verdict) out.byInspection++;
      else out.bySearch++;
    }
  }
  return out;
}
