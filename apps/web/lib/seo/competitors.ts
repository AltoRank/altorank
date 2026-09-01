// ---------------------------------------------------------------------------
// Who else ranks for what this domain ranks for
// ---------------------------------------------------------------------------
//
// The growth plan's "gaps" block needs competitors and cannot ask the visitor
// for them: the whole point of the free check is that it works from a domain
// alone. DataForSEO Labs answers this from the SERP index in one call. A
// competitor here is a domain that shares ranking keywords with the target,
// weighted by how many, so it is an observation about the SERP rather than a
// guess about the market.
//
// SHAPE WARNING, inherited from ranked-keywords.ts: every field is optional and
// the parser returns what it can rather than throwing. Verified against a live
// response on 2026-09-01 (see the test fixture, which is a captured row).

import { post } from "./client";

export interface OrganicCompetitor {
  domain: string;
  /** How many of the target's ranking keywords this domain also ranks for. */
  sharedKeywords: number;
  /** Average position across the shared keywords, lower is stronger. */
  avgPosition: number | null;
  /** Estimated monthly organic traffic across all their keywords, if reported. */
  estimatedTraffic: number | null;
}

type DFSCompetitorItem = {
  domain?: string | null;
  avg_position?: number | null;
  intersections?: number | null;
  full_domain_metrics?: {
    organic?: { etv?: number | null; count?: number | null } | null;
  } | null;
};

type CompetitorsResult = {
  target?: string;
  items?: DFSCompetitorItem[] | null;
};

function num(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** Hosts that share keywords with everyone and tell a small site nothing. */
const GENERIC_HOSTS = /(^|\.)(wikipedia\.org|youtube\.com|reddit\.com|quora\.com|amazon\.[a-z.]+|linkedin\.com|facebook\.com|medium\.com|github\.com|pinterest\.com|instagram\.com|x\.com|twitter\.com)$/i;

export function parseCompetitorItem(item: DFSCompetitorItem): OrganicCompetitor | null {
  const domain = (item.domain ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (!domain) return null;
  return {
    domain,
    sharedKeywords: num(item.intersections) ?? 0,
    avgPosition: num(item.avg_position),
    estimatedTraffic: num(item.full_domain_metrics?.organic?.etv),
  };
}

/**
 * Pick the competitors worth comparing against: not the target itself, not a
 * platform everyone shares keywords with, and ordered by how much of the
 * target's keyword set they overlap.
 */
export function rankCompetitors(
  target: string,
  items: OrganicCompetitor[],
  limit = 3,
): OrganicCompetitor[] {
  const self = target.toLowerCase().replace(/^www\./, "");
  return items
    .filter((c) => c.domain !== self && !GENERIC_HOSTS.test(c.domain) && c.sharedKeywords > 0)
    .sort((a, b) => b.sharedKeywords - a.sharedKeywords)
    .slice(0, limit);
}

export async function fetchOrganicCompetitors(
  domain: string,
  options?: { languageCode?: string; locationCode?: number; limit?: number },
): Promise<OrganicCompetitor[]> {
  const target = domain.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const response = await post<CompetitorsResult>(
    "/dataforseo_labs/google/competitors_domain/live",
    [
      {
        target,
        language_code: options?.languageCode ?? "en",
        location_code: options?.locationCode ?? 2840,
        // The API's own filter for wikipedia-class domains; GENERIC_HOSTS above
        // is the belt to this brace.
        exclude_top_domains: true,
        limit: options?.limit ?? 20,
      },
    ],
  );

  const out: OrganicCompetitor[] = [];
  for (const task of response.tasks ?? []) {
    for (const result of task.result ?? []) {
      const items = Array.isArray(result?.items) ? result.items : [result as unknown as DFSCompetitorItem];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const parsed = parseCompetitorItem(item);
        if (parsed) out.push(parsed);
      }
    }
  }
  return rankCompetitors(target, out, options?.limit ?? 20);
}
