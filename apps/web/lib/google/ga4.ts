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

// ---------------------------------------------------------------------------
// Which GA4 property does this account have for this site?
// ---------------------------------------------------------------------------
//
// The sync only ran when `config.ga4PropertyId` was set, and nothing ever set
// it, so GA4 was permanently "Not connected" even though the consent screen
// already granted its scope alongside Search Console. Ask the Admin API what
// the account can see, and match a property by the data stream's domain.

const GA4_ADMIN = "https://analyticsadmin.googleapis.com/v1beta";

export type GA4Property = { name: string; propertyId: string; displayName: string };

export async function listGA4Properties(accessToken: string): Promise<GA4Property[]> {
  const res = await fetch(`${GA4_ADMIN}/accountSummaries?pageSize=200`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`GA4 admin error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    accountSummaries?: { propertySummaries?: { property?: string; displayName?: string }[] }[];
  };
  const out: GA4Property[] = [];
  for (const acc of body.accountSummaries ?? []) {
    for (const p of acc.propertySummaries ?? []) {
      if (!p.property) continue;
      out.push({ name: p.property, propertyId: p.property.replace("properties/", ""), displayName: p.displayName ?? p.property });
    }
  }
  return out;
}

/** Property whose display name contains the domain or its brand word. */
export function matchGA4Property(properties: GA4Property[], domain: string): GA4Property | null {
  const bare = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const brand = bare.split(".")[0];
  const byDomain = properties.find((p) => p.displayName.toLowerCase().includes(bare));
  if (byDomain) return byDomain;
  const byBrand = properties.filter((p) => p.displayName.toLowerCase().includes(brand));
  // Only when it is unambiguous: two properties matching "acme" tell us nothing.
  return byBrand.length === 1 ? byBrand[0] : null;
}
