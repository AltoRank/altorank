// ---------------------------------------------------------------------------
// Website traffic value estimator (page slug: website-worth-calculator)
// ---------------------------------------------------------------------------
//
// NOT a valuation, and every label says so. One DataForSEO Labs
// domain_rank_overview call with no location: the provider answers one row
// per market it has data for. For each, `etv` is modelled monthly organic
// visits and `estimated_paid_traffic_cost` is what those visits would cost as
// ads (visits times keyword CPC). The tool sums the markets and shows the
// largest ones.

import { z } from "zod";
import { defineTool } from "../types";
import { dataforseoLive } from "../data";
import { kv, table, text, type Block } from "../blocks";
import { publicDomain } from "../fields";
import { languageName, locationName } from "../locations";
import { fmtInt } from "../labs";

const SLUG = "website-worth-calculator";
export const MARKET_LIMIT = 200;

interface OrganicMetrics {
  etv?: number | null;
  count?: number | null;
  estimated_paid_traffic_cost?: number | null;
}
interface OverviewItem {
  location_code?: number | null;
  language_code?: string | null;
  metrics?: { organic?: OrganicMetrics | null } | null;
}
interface OverviewResult {
  total_count?: number | null;
  items?: OverviewItem[] | null;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export interface Market {
  location: number;
  language: string;
  visits: number;
  value: number;
  keywords: number;
}

export function markets(items: OverviewItem[]): Market[] {
  return items
    .map((i) => ({
      location: i.location_code ?? 0,
      language: i.language_code ?? "",
      visits: i.metrics?.organic?.etv ?? 0,
      value: i.metrics?.organic?.estimated_paid_traffic_cost ?? 0,
      keywords: i.metrics?.organic?.count ?? 0,
    }))
    .filter((m) => m.visits > 0 || m.value > 0 || m.keywords > 0)
    .sort((a, b) => b.value - a.value || b.visits - a.visits);
}

export const websiteWorthCalculator = defineTool({
  slug: SLUG,
  kind: "data",
  input: z.object({ domain: publicDomain }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  // One domain_rank_overview call; cost grows with the number of market rows (capped).
  estimateCents: 5,
  async run({ domain }) {
    const [overview] = await dataforseoLive<OverviewResult>(SLUG, "/dataforseo_labs/google/domain_rank_overview/live", {
      target: domain,
      limit: MARKET_LIMIT,
    });
    const rows = markets(overview?.items ?? []);
    if (!rows.length) {
      return [
        kv([{ label: "Estimated monthly traffic value", value: "no data", status: "warn" }], domain),
        text(
          "DataForSEO has no organic rankings on record for this domain, so there is nothing to estimate. New and small sites often show nothing here; your own analytics are the better source.",
          "No ranking data",
        ),
      ];
    }

    const total = rows.reduce((a, m) => ({ visits: a.visits + m.visits, value: a.value + m.value, keywords: a.keywords + m.keywords }), {
      visits: 0,
      value: 0,
      keywords: 0,
    });
    const partial = (overview?.total_count ?? 0) > (overview?.items?.length ?? 0);

    const blocks: Block[] = [
      kv(
        [
          { label: "Estimated monthly traffic value (USD)", value: `${usd(total.value)} per month`, status: "info" },
          { label: "Modelled monthly organic visits", value: fmtInt(total.visits), status: "info" },
          { label: "Ranking keywords", value: fmtInt(total.keywords), status: "info" },
          {
            label: "Markets counted",
            value: partial
              ? `${overview?.items?.length} of the ${overview?.total_count} with data; the rest are not in the total, so it is an undercount`
              : String(rows.length),
            status: partial ? "warn" : "info",
          },
        ],
        `${domain}: what its organic traffic would cost as ads`,
      ),
      table(
        ["Market", "Language", "Modelled visits / month", "Traffic value (USD / month)", "Keywords"],
        rows.slice(0, 10).map((m) => [locationName(m.location), languageName(m.language), Math.round(m.visits), Math.round(m.value), m.keywords]),
        "Largest markets",
      ),
      text(
        "This is what the site's modelled organic search traffic would cost if the same visits were bought as ads: modelled visits times each keyword's cost per click, from DataForSEO. It is a stack of estimates, good to an order of magnitude and for comparing sites measured the same way. It is not a valuation of the business and not what the site would sell for, which depends on revenue and profit.",
        "What this number is, and is not",
      ),
    ];
    return blocks;
  },
});
