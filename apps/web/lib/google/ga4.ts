const GA4_API = "https://analyticsdata.googleapis.com/v1beta";

/**
 * Search Console and Analytics are separate consents now (lib/google/oauth.ts),
 * so a Google token can hold Search Console without Analytics. Google answers
 * that with a 403 naming the scope; this says what to do about it instead.
 */
export const GA4_NOT_GRANTED_MESSAGE =
  "This Google connection does not include Google Analytics. Connect Google Analytics for this site to read it.";

export class GA4ScopeMissingError extends Error {
  constructor() {
    super(GA4_NOT_GRANTED_MESSAGE);
    this.name = "GA4ScopeMissingError";
  }
}

/** Google's 403 for a token that was never granted the scope the call needs. */
export function isScopeInsufficient(status: number, body: string): boolean {
  return status === 403 && /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(body);
}

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
    if (isScopeInsufficient(res.status, err)) throw new GA4ScopeMissingError();
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
// it, so GA4 was permanently "Not connected" even though its scope had been
// granted. Ask the Admin API what the account can see, and match a property
// by the data stream's domain.

const GA4_ADMIN = "https://analyticsadmin.googleapis.com/v1beta";

export type GA4Property = { name: string; propertyId: string; displayName: string };

export async function listGA4Properties(accessToken: string): Promise<GA4Property[]> {
  const res = await fetch(`${GA4_ADMIN}/accountSummaries?pageSize=200`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.text();
    if (isScopeInsufficient(res.status, err)) throw new GA4ScopeMissingError();
    throw new Error(`GA4 admin error (${res.status}): ${err.slice(0, 200)}`);
  }
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
