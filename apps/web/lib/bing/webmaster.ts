// ---------------------------------------------------------------------------
// Bing Webmaster Tools: the other search console
// ---------------------------------------------------------------------------
//
// Bing serves its own results and, through its index, Yahoo's and DuckDuckGo's.
// It also runs Copilot's web retrieval. Its share of search is small next to
// Google - low single digits globally, higher on US desktop - but it is the
// second console a site can be measured in, and this product's whole premise is
// that a number nobody measured is not a number.
//
// Shapes below are taken from Microsoft's own documentation, not from memory:
//
//   GET https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=K
//     { "d": [ { "Url": "http://example.com", "IsVerified": true, ... } ] }
//   GET .../GetRankAndTrafficStats?siteUrl=S&apikey=K
//     { "d": [ { "Clicks": 15, "Date": "/Date(1316156400000-0700)/", "Impressions": 100 } ] }
//     "updated every day"
//   GET .../GetQueryStats?siteUrl=S&apikey=K  (and GetPageStats)
//     one row per query, aggregated, "updated every week"
//
// Only the daily series is stored. The query and page reports are aggregates
// over Bing's window with a single Date on them; writing those into a table
// whose rows mean "this happened on this day" would put a week's total under
// one date and inflate every sum that touched it.
//
// Auth is the per-user API key from Bing Webmaster Tools > Settings > API
// access. Bing also offers OAuth 2.0 and recommends it; the key is one field
// to paste instead of an app registration, which is the right trade for a
// product whose Google flow already took an afternoon of Cloud Console.

const BING_API = "https://ssl.bing.com/webmaster/api.svc/json";

export type BingSite = { url: string; isVerified: boolean };
export type BingDaily = { date: string; clicks: number; impressions: number };

/**
 * Bing's WCF date: "/Date(1316156400000-0700)/", milliseconds since the epoch
 * with an informational offset. The day is taken in UTC from the millisecond
 * value, which for a midnight-local timestamp is the same calendar day. Plain
 * ISO strings are accepted too, since the XML flavour of the API uses them.
 */
export function parseBingDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const wcf = raw.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  if (wcf) {
    const d = new Date(Number(wcf[1]));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Unwrap `{ d: [...] }`; tolerate a bare array in case the wrapper ever goes. */
export function unwrap<T = unknown>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as { d?: unknown }).d)) {
    return (body as { d: T[] }).d;
  }
  return [];
}

async function call<T>(method: string, params: Record<string, string>): Promise<T[]> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${BING_API}/${method}?${qs}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403 || /InvalidApiKey|api ?key/i.test(text)) {
      throw new Error("Bing rejected the API key. Generate one in Bing Webmaster Tools under Settings, API access, and paste it exactly.");
    }
    throw new Error(`Bing Webmaster API ${method} failed (${res.status}): ${text}`);
  }
  return unwrap<T>(await res.json());
}

/** Every site this key's account has added, verified or not. */
export async function listBingSites(apiKey: string): Promise<BingSite[]> {
  const rows = await call<{ Url?: string; IsVerified?: boolean }>("GetUserSites", { apikey: apiKey });
  return rows
    .filter((r): r is { Url: string; IsVerified?: boolean } => typeof r.Url === "string" && r.Url.length > 0)
    .map((r) => ({ url: r.Url, isVerified: Boolean(r.IsVerified) }));
}

const bareHost = (u: string) =>
  u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");

/**
 * The verified Bing site for a domain: exact host first, then a www or scheme
 * variant, then any verified site whose host is this domain or under it.
 * Unverified sites never match: Bing serves no data for them, and pointing the
 * sync at one would report a site as measured-and-empty for ever.
 */
export function matchBingSite(sites: BingSite[], domain: string): BingSite | null {
  const want = bareHost(domain);
  if (!want) return null;
  const verified = sites.filter((s) => s.isVerified);
  const exact = verified.find((s) => bareHost(s.url) === want);
  if (exact) return exact;
  return verified.find((s) => bareHost(s.url).endsWith(`.${want}`)) ?? null;
}

/** Clicks and impressions per day, as far back as Bing keeps them (about six months). */
export async function fetchBingDailyTraffic(apiKey: string, siteUrl: string): Promise<BingDaily[]> {
  const rows = await call<{ Date?: unknown; Clicks?: unknown; Impressions?: unknown }>(
    "GetRankAndTrafficStats",
    { siteUrl, apikey: apiKey },
  );
  const out: BingDaily[] = [];
  for (const r of rows) {
    const date = parseBingDate(r.Date);
    if (!date) continue;
    out.push({
      date,
      clicks: typeof r.Clicks === "number" ? r.Clicks : Number(r.Clicks ?? 0) || 0,
      impressions: typeof r.Impressions === "number" ? r.Impressions : Number(r.Impressions ?? 0) || 0,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
