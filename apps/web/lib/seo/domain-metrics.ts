// ---------------------------------------------------------------------------
// Domain authority and traffic, measured rather than dashed
// ---------------------------------------------------------------------------
//
// The workspace table showed "—" for authority and traffic on every row,
// which was the honest rendering of columns nothing ever wrote. The data was
// a call away on the account we already pay: DataForSEO's backlinks summary
// carries a 0-1000 domain rank, and Labs' rank overview carries an estimated
// organic traffic value.
//
// Verified against the live API on 2026-08-30 before this file existed
// (rule 6): cal.com returned rank 631 / 43,027 referring domains, and an
// organic ETV of ~172,000.
//
// One honesty rule: the rank here is DataForSEO's, on a 0-1000 scale, mapped
// to 0-100. It is NOT Ahrefs DR and the UI must not call it DR - the column
// is labelled Authority. Presenting one vendor's number under another
// vendor's brand name is a small lie that compounds.

import { post, hasDataForSEOCredentials } from "@/lib/seo/client";

export type DomainMetrics = {
  /** DataForSEO backlink rank mapped to 0-100. Null when unmeasured. */
  authority: number | null;
  /** Estimated monthly organic visits from ranked keywords. Null when unmeasured. */
  traffic: number | null;
  referringDomains: number | null;
};

type BacklinksSummaryResult = {
  rank: number | null;
  referring_domains: number | null;
};

type RankOverviewResult = {
  items:
    | Array<{ metrics?: { organic?: { etv?: number | null } } }>
    | null;
};

/**
 * Fetch both metrics, tolerating either endpoint failing alone: an account
 * without the backlinks module still gets traffic, and vice versa. Returns
 * nulls rather than throwing, because this runs inside onboarding and a
 * metrics lookup must never take workspace creation down with it.
 */
export async function fetchDomainMetrics(
  domain: string,
  options?: { languageCode?: string; locationCode?: number },
): Promise<DomainMetrics> {
  const out: DomainMetrics = { authority: null, traffic: null, referringDomains: null };
  if (!hasDataForSEOCredentials()) return out;

  const [backlinks, overview] = await Promise.allSettled([
    post<BacklinksSummaryResult>("/backlinks/summary/live", [
      { target: domain, internal_list_limit: 1 },
    ]),
    post<RankOverviewResult>("/dataforseo_labs/google/domain_rank_overview/live", [
      {
        target: domain,
        location_code: options?.locationCode ?? 2840,
        language_code: options?.languageCode ?? "en",
      },
    ]),
  ]);

  if (backlinks.status === "fulfilled") {
    const r = backlinks.value.tasks[0]?.result?.[0];
    if (typeof r?.rank === "number") out.authority = Math.round(r.rank / 10);
    if (typeof r?.referring_domains === "number") out.referringDomains = r.referring_domains;
  } else {
    console.warn("[domain-metrics] backlinks summary failed:", backlinks.reason);
  }

  if (overview.status === "fulfilled") {
    const etv = overview.value.tasks[0]?.result?.[0]?.items?.[0]?.metrics?.organic?.etv;
    if (typeof etv === "number") out.traffic = Math.round(etv);
  } else {
    console.warn("[domain-metrics] rank overview failed:", overview.reason);
  }

  return out;
}
