// ---------------------------------------------------------------------------
// Backlink checker: link counts and a sample of linking pages for a domain
// ---------------------------------------------------------------------------
//
// Two DataForSEO Backlinks API calls in parallel: the summary (counts), and
// live backlinks with one link per referring domain, strongest domains first
// (the sample). The Backlinks API is a separate subscription at the provider;
// if the account loses it, both calls fail and the visitor reads the
// `upstream` sentence below instead of a generic one.

import { z } from "zod";
import { defineTool } from "../types";
import { dataforseoLive } from "../data";
import { ToolError } from "../errors";
import { kv, table, text, type Block, type KvItem } from "../blocks";
import { publicDomain } from "../fields";
import { fmtInt } from "../labs";

const SLUG = "backlink-checker";
export const SAMPLE_SIZE = 20;
const UNAVAILABLE = "The backlink index behind this tool is unavailable right now. Try again later.";

interface SummaryResult {
  backlinks?: number | null;
  referring_domains?: number | null;
  referring_domains_nofollow?: number | null;
  referring_main_domains?: number | null;
  referring_ips?: number | null;
  broken_backlinks?: number | null;
  rank?: number | null;
  first_seen?: string | null;
  backlinks_spam_score?: number | null;
}
interface BacklinkItem {
  url_from?: string;
  domain_from?: string;
  domain_from_rank?: number | null;
  url_to?: string;
  anchor?: string | null;
  dofollow?: boolean;
  first_seen?: string | null;
}
interface BacklinksResult {
  total_count?: number | null;
  items?: BacklinkItem[] | null;
}

const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : "—");

export const backlinkChecker = defineTool({
  slug: SLUG,
  kind: "data",
  input: z.object({ domain: publicDomain }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  // Backlinks summary + one page of live backlinks, with headroom.
  estimateCents: 6,
  async run({ domain }) {
    const common = { target: domain, include_subdomains: true, backlinks_status_type: "live" };
    const [summaryRes, listRes] = await Promise.allSettled([
      dataforseoLive<SummaryResult>(SLUG, "/backlinks/summary/live", { ...common, internal_list_limit: 0 }),
      dataforseoLive<BacklinksResult>(SLUG, "/backlinks/backlinks/live", {
        ...common,
        mode: "one_per_domain",
        limit: SAMPLE_SIZE,
        order_by: ["domain_from_rank,desc"],
      }),
    ]);
    if (summaryRes.status === "rejected") {
      throw summaryRes.reason instanceof ToolError ? new ToolError("upstream", UNAVAILABLE) : summaryRes.reason;
    }
    const s = summaryRes.value[0];
    const sample = listRes.status === "fulfilled" ? (listRes.value[0]?.items ?? []) : [];

    if (!s || (!s.backlinks && !s.referring_domains)) {
      return [
        kv([{ label: "Backlinks found", value: "none", status: "warn" }], `Backlinks to ${domain}`),
        text(
          "DataForSEO's crawler has not found live links to this domain. New sites and sites with few links often show nothing yet. Google Search Console's Links report shows the links Google has found.",
          "No links in the index",
        ),
      ];
    }

    const nofollowShare =
      s.referring_domains && typeof s.referring_domains_nofollow === "number"
        ? Math.round((s.referring_domains_nofollow / s.referring_domains) * 100)
        : null;
    const items: KvItem[] = [
      { label: "Backlinks", value: fmtInt(s.backlinks ?? null), status: "info" },
      { label: "Referring domains", value: fmtInt(s.referring_domains ?? null), status: "info" },
      ...(nofollowShare !== null ? [{ label: "Referring domains linking nofollow", value: `${nofollowShare}%`, status: "info" as const }] : []),
      { label: "Referring IPs", value: fmtInt(s.referring_ips ?? null), status: "info" },
      { label: "Domain rank (DataForSEO, 0-1000)", value: fmtInt(s.rank ?? null), status: "info" },
      { label: "Broken backlinks", value: fmtInt(s.broken_backlinks ?? null), status: s.broken_backlinks ? "warn" : "info" },
      { label: "First seen by the crawler", value: day(s.first_seen), status: "info" },
    ];

    const blocks: Block[] = [kv(items, `Backlinks to ${domain}`)];
    if (sample.length) {
      blocks.push(
        table(
          ["Linking page", "Domain rank", "Links to", "Anchor text", "Follow", "First seen"],
          sample.map((b) => [b.url_from ?? "", b.domain_from_rank ?? null, b.url_to ?? "", b.anchor ?? "", b.dofollow ? "follow" : "nofollow", day(b.first_seen)]),
          `Sample: one link from each of the ${sample.length} strongest referring domains`,
        ),
      );
    } else if (listRes.status === "rejected") {
      blocks.push(text("The sample of linking pages could not be loaded this time. The counts above are complete.", "Sample"));
    }
    blocks.push(
      text(
        "From DataForSEO's backlink index, a third-party crawl of the web: counts of live links it has found, not Google's link data. No index sees every link, and different tools report different numbers, so compare within one tool. A link listed here is not necessarily one Google counts.",
        "About these numbers",
      ),
    );
    return blocks;
  },
});
