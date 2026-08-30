const GA4_API = "https://analyticsdata.googleapis.com/v1beta";

export interface GA4PageMetrics {
  pageUrl: string;
  pageviews: number;
  sessions: number;
  engagementRate: number;
}

/**
 * Fetch page-level metrics from GA4 Data API.
 */
export async function fetchGA4Metrics(
  accessToken: string,
  propertyId: string,
  startDate: string,
  endDate: string,
): Promise<GA4PageMetrics[]> {
  const res = await fetch(
    `${GA4_API}/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "pagePath" }],
        metrics: [
          { name: "screenPageViews" },
          { name: "sessions" },
          { name: "engagementRate" },
        ],
        limit: 500,
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA4 API error (${res.status}): ${err}`);
  }

  const data = await res.json();

  return (data.rows ?? []).map(
    (row: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }) => ({
      pageUrl: row.dimensionValues[0]?.value ?? "",
      pageviews: parseInt(row.metricValues[0]?.value ?? "0", 10),
      sessions: parseInt(row.metricValues[1]?.value ?? "0", 10),
      engagementRate: parseFloat(row.metricValues[2]?.value ?? "0"),
    }),
  );
}
