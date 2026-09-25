// ---------------------------------------------------------------------------
// Google rank checker: one live Google search, where does the domain appear
// ---------------------------------------------------------------------------
//
// One DataForSEO live SERP call (advanced, top 100 organic results) for the
// keyword in the chosen country. "Position" is the organic rank (rank_group):
// ads, answer boxes and other features are not counted, which is how people
// usually mean "position". A subdomain counts as the domain.

import { z } from "zod";
import { defineTool } from "../types";
import { dataforseoLive } from "../data";
import { kv, table, text, type Block, type KvItem } from "../blocks";
import { countryInput, publicDomain, requiredText } from "../fields";
import { COUNTRIES } from "../locations";

const SLUG = "google-rank-checker";
export const DEPTH = 100;

interface SerpItem {
  type: string;
  rank_group?: number;
  rank_absolute?: number;
  domain?: string;
  url?: string;
  title?: string;
}
interface SerpResult {
  datetime?: string;
  check_url?: string;
  items?: SerpItem[] | null;
}

export function sameSite(host: string | undefined, domain: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, "");
  return h === domain || h.endsWith(`.${domain}`);
}

export const googleRankChecker = defineTool({
  slug: SLUG,
  kind: "data",
  input: z.object({
    domain: publicDomain,
    keyword: requiredText("a keyword", 100),
    country: countryInput,
  }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  // One live advanced SERP at depth 100, with headroom for a retried fault.
  estimateCents: 3,
  async run({ domain, keyword, country }) {
    const loc = COUNTRIES[country];
    const [serp] = await dataforseoLive<SerpResult>(SLUG, "/serp/google/organic/live/advanced", {
      keyword,
      location_code: loc.locationCode,
      language_code: loc.languageCode,
      device: "desktop",
      depth: DEPTH,
    });
    const organic = (serp?.items ?? []).filter((i) => i.type === "organic" && typeof i.rank_group === "number");
    organic.sort((a, b) => (a.rank_group ?? 0) - (b.rank_group ?? 0));
    const mine = organic.filter((i) => sameSite(i.domain, domain));
    const best = mine[0];

    const items: KvItem[] = best
      ? [
          { label: "Position", value: `#${best.rank_group} in organic results`, status: best.rank_group! <= 10 ? "pass" : "info" },
          { label: "Ranking URL", value: best.url ?? "", status: "info" },
        ]
      : [{ label: "Position", value: `not in the top ${organic.length || DEPTH} organic results`, status: "warn" }];
    if (mine.length > 1) {
      items.push({
        label: "Also ranks",
        value: mine
          .slice(1, 4)
          .map((i) => `#${i.rank_group} ${i.url}`)
          .join(", "),
        status: "info",
      });
    }
    items.push({ label: "Search", value: `"${keyword}", Google ${loc.name}, desktop`, status: "info" });
    if (serp?.datetime) items.push({ label: "Checked", value: serp.datetime.replace(/ \+00:00$/, " UTC"), status: "info" });

    const blocks: Block[] = [kv(items, `${domain} for "${keyword}"`)];
    if (organic.length) {
      blocks.push(
        table(
          ["Position", "Domain", "URL", "Title", "This domain"],
          organic.slice(0, 10).map((i) => [i.rank_group ?? null, (i.domain ?? "").replace(/^www\./, ""), i.url ?? "", i.title ?? "", sameSite(i.domain, domain) ? "yes" : ""]),
          "Top 10 organic results",
        ),
      );
    } else {
      blocks.push(text("The search returned no organic results.", "Results"));
    }
    blocks.push(
      text(
        `One live Google search for this keyword in ${loc.name}, fetched through DataForSEO. It is a real result but a snapshot: rankings vary with location, device, language and time, so someone else may see a different order. For your own site, the average position in Google Search Console is the better measure.`,
        "About this result",
      ),
    );
    return blocks;
  },
});
