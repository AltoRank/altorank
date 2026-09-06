const GSC_API = "https://www.googleapis.com/webmasters/v3";

export interface GSCQueryMetrics {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GSCPageMetrics {
  pageUrl: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GSCQueryPageMetrics {
  query: string;
  pageUrl: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** The property's own total for a day, with no dimension applied. */
export interface GSCTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

type RawRow = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };

/** Thrown for a non-2xx answer, with the status kept so a caller can tell a
 *  permission problem (403) from an outage. */
export class GSCApiError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`GSC API error (${status}): ${body}`);
    this.name = "GSCApiError";
  }
}

/**
 * One Search Analytics call. Four reports used to be four copies of this
 * fetch; the dimensions are the only thing that differs between them.
 */
async function searchAnalytics(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
  dimensions: string[],
  rowLimit = 500,
): Promise<RawRow[]> {
  const res = await fetch(
    `${GSC_API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ startDate, endDate, dimensions, rowLimit }),
    },
  );

  if (!res.ok) throw new GSCApiError(res.status, await res.text());

  const data = (await res.json()) as { rows?: RawRow[] };
  return data.rows ?? [];
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Fetch search query performance from Google Search Console.
 */
export async function fetchGSCQueryMetrics(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
): Promise<GSCQueryMetrics[]> {
  const rows = await searchAnalytics(accessToken, siteUrl, startDate, endDate, ["query"]);
  return rows.map((row) => ({
    query: row.keys?.[0] ?? "",
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: round4(row.ctr),
    position: round2(row.position),
  }));
}

/**
 * Fetch page-level performance from Google Search Console.
 */
export async function fetchGSCPageMetrics(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
): Promise<GSCPageMetrics[]> {
  const rows = await searchAnalytics(accessToken, siteUrl, startDate, endDate, ["page"]);
  return rows.map((row) => ({
    pageUrl: row.keys?.[0] ?? "",
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: round4(row.ctr),
    position: round2(row.position),
  }));
}

/**
 * Which of our pages Google shows for which query. Two pages under one query
 * is cannibalisation, and neither the query report nor the page report can
 * see it: each collapses the other dimension.
 */
export async function fetchGSCQueryPageMetrics(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
): Promise<GSCQueryPageMetrics[]> {
  const rows = await searchAnalytics(accessToken, siteUrl, startDate, endDate, ["query", "page"]);
  return rows.map((row) => ({
    query: row.keys?.[0] ?? "",
    pageUrl: row.keys?.[1] ?? "",
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: round4(row.ctr),
    position: round2(row.position),
  }));
}

/**
 * The property's total for one day. Summing the query report undercounts
 * (Google withholds anonymised queries from it) and summing the page report
 * counts nothing a page did not earn; the undimensioned call is the number
 * Search Console itself shows.
 */
export async function fetchGSCDailyTotals(
  accessToken: string,
  siteUrl: string,
  date: string,
): Promise<GSCTotals | null> {
  const rows = await searchAnalytics(accessToken, siteUrl, date, date, []);
  const row = rows[0];
  if (!row) return null;
  return { clicks: row.clicks, impressions: row.impressions, ctr: round4(row.ctr), position: round2(row.position) };
}

// ---------------------------------------------------------------------------
// URL Inspection
// ---------------------------------------------------------------------------
//
// A different host from the analytics API, and a POST per URL. Accepts the
// `webmasters.readonly` scope we already hold. Quota is per property and per
// day; one click on one article is far inside it, a loop over a sitemap is
// not, which is why nothing here is called from a cron.

const INSPECTION_API = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

/** Raw response body of urlInspection.index:inspect; lib/google/inspection.ts parses it. */
export async function inspectUrl(accessToken: string, siteUrl: string, inspectionUrl: string): Promise<unknown> {
  const res = await fetch(INSPECTION_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: "en-US" }),
  });
  if (!res.ok) throw new GSCApiError(res.status, (await res.text()).slice(0, 300));
  return res.json();
}

// ---------------------------------------------------------------------------
// Which property does this account actually have?
// ---------------------------------------------------------------------------
//
// The sync assumed `sc-domain:<workspace domain>`. Search Console has two
// property kinds and the account may own either, or neither: connecting
// altorank.co with an account that is not a verified owner produced a 403 on
// every nightly run, worded as a permission problem nobody would see
// (2026-09-02). Ask Google what it has, match it to the domain, and store the
// answer.

export type GSCSite = { siteUrl: string; permissionLevel: string };

export async function listGSCSites(accessToken: string): Promise<GSCSite[]> {
  const res = await fetch(`${GSC_API}/sites`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`GSC sites list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { siteEntry?: { siteUrl?: string; permissionLevel?: string }[] };
  return (body.siteEntry ?? [])
    .filter((s): s is { siteUrl: string; permissionLevel?: string } => Boolean(s.siteUrl))
    .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel ?? "unknown" }));
}

/** Read-only permissions cannot query search analytics. */
const USABLE = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);

/**
 * The property that covers this domain: a domain property first (it covers
 * every subdomain and scheme), then https, then www, then http.
 */
export function matchGSCSite(sites: GSCSite[], domain: string): GSCSite | null {
  const bare = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const usable = sites.filter((s) => USABLE.has(s.permissionLevel));
  const candidates = [
    `sc-domain:${bare}`,
    `https://${bare}/`,
    `https://www.${bare}/`,
    `http://${bare}/`,
    `http://www.${bare}/`,
  ];
  for (const c of candidates) {
    const hit = usable.find((s) => s.siteUrl.toLowerCase() === c);
    if (hit) return hit;
  }
  // A property for a subdomain of this domain is better than nothing.
  return usable.find((s) => s.siteUrl.toLowerCase().includes(bare)) ?? null;
}
