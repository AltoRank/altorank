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
