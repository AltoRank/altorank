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

/**
 * Fetch search query performance from Google Search Console.
 */
export async function fetchGSCQueryMetrics(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
): Promise<GSCQueryMetrics[]> {
  const res = await fetch(
    `${GSC_API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ["query"],
        rowLimit: 500,
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GSC API error (${res.status}): ${err}`);
  }

  const data = await res.json();

  return (data.rows ?? []).map(
    (row: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }) => ({
      query: row.keys[0] ?? "",
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: Math.round(row.ctr * 10000) / 10000,
      position: Math.round(row.position * 100) / 100,
    }),
  );
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
  const res = await fetch(
    `${GSC_API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ["page"],
        rowLimit: 500,
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GSC API error (${res.status}): ${err}`);
  }

  const data = await res.json();

  return (data.rows ?? []).map(
    (row: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }) => ({
      pageUrl: row.keys[0] ?? "",
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: Math.round(row.ctr * 10000) / 10000,
      position: Math.round(row.position * 100) / 100,
    }),
  );
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
