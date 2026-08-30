// ---------------------------------------------------------------------------
// Backlink monitoring via DataForSEO
// ---------------------------------------------------------------------------

import { post } from "./client";

/** Single backlink item from DataForSEO. */
type DFSBacklinkItem = {
  url_from: string;
  domain_from: string;
  domain_from_rank: number | null;
  anchor: string | null;
  url_to: string;
};

/** Result wrapper for the backlinks/live task. */
type BacklinksResult = {
  items: DFSBacklinkItem[] | null;
};

export type BacklinkData = {
  sourceDomain: string;
  sourceDr: number;
  anchorText: string;
  targetUrl: string;
};

/**
 * Fetch backlink data for a domain using DataForSEO's
 * backlinks/live endpoint.
 */
export async function getBacklinksData(
  domain: string,
): Promise<BacklinkData[]> {
  const response = await post<BacklinksResult>("/backlinks/backlinks/live", [
    {
      target: domain,
      limit: 100,
      order_by: ["rank.desc"],
    },
  ]);

  const results: BacklinkData[] = [];

  for (const task of response.tasks) {
    if (!task.result) continue;

    for (const result of task.result) {
      if (!result.items) continue;

      for (const item of result.items) {
        results.push({
          sourceDomain: item.domain_from,
          sourceDr: item.domain_from_rank ?? 0,
          anchorText: item.anchor ?? "",
          targetUrl: item.url_to,
        });
      }
    }
  }

  return results;
}
