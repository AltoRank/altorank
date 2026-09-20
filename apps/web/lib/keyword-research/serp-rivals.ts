// ---------------------------------------------------------------------------
// Rivals read off the results page, not off the homepage
// ---------------------------------------------------------------------------
//
// The rivals a profile names are whoever the homepage mentions: for a European
// challenger that is the American incumbents (fitsuite.co named trainerize,
// truecoach and pt distinction). Read in the site's own locale they returned
// six rows, four of them nothing a buyer would search. The sites that hold the
// site's market in its language are the ones already ranking for its buyer
// phrases, and those are on the results page for the seeds (the same run's
// SERPs showed revoo, qomodo and gymkee, which no model reading the homepage
// could have known).
//
// So: search a few of the buyer seeds in the site's locale, count which hosts
// keep turning up, and read what THOSE rank for. Their rows carry measured
// volume in the right language, which is what the plan is short of.

import { fetchAdvancedSerp } from "@/lib/seo/brief-data";
import { NOT_A_RIVAL } from "@/lib/onboarding/competitor-domains";
import { diverseSeeds } from "./diversity";

/** Seeds searched to find rivals. One live SERP each. */
export const MAX_RIVAL_SERPS = 3;
/** Rivals read from the results pages. One `ranked_keywords` task each. */
export const MAX_SERP_RIVALS = 3;

const bare = (h: string) => h.replace(/^www\./, "").toLowerCase();

/**
 * The hosts that hold these results pages.
 *
 * Ranked by how many of the pages a host appears on, then by how high. A host
 * on one page is a result; a host on two is a competitor. Directories, social
 * sites and app stores rank for everything and are nobody's rival.
 */
export function pickSerpRivals(
  pages: readonly (readonly string[])[],
  exclude: ReadonlySet<string>,
  limit = MAX_SERP_RIVALS,
): string[] {
  const seen = new Map<string, { pages: number; rank: number }>();
  for (const hosts of pages) {
    const onThisPage = new Set<string>();
    hosts.forEach((raw, i) => {
      const host = bare(raw);
      if (!host || onThisPage.has(host) || exclude.has(host) || NOT_A_RIVAL.test(host)) return;
      onThisPage.add(host);
      const at = seen.get(host) ?? { pages: 0, rank: 0 };
      seen.set(host, { pages: at.pages + 1, rank: at.rank + i });
    });
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].pages - a[1].pages || a[1].rank / a[1].pages - b[1].rank / b[1].pages)
    .slice(0, limit)
    .map(([host]) => host);
}

export interface SerpRivals {
  rivals: string[];
  /** Seeds whose results page was read. */
  searched: string[];
  /** Seeds whose search errored, as opposed to returning nothing. */
  failed: string[];
}

export async function findSerpRivals(
  seeds: readonly string[],
  locale: { languageCode: string; locationCode: number },
  exclude: ReadonlySet<string>,
  deps: { search?: (term: string) => Promise<string[]> } = {},
): Promise<SerpRivals> {
  const search = deps.search ?? (async (term: string) => {
    const serp = await fetchAdvancedSerp(term, locale);
    return serp.organic.slice(0, 10).flatMap((r) => {
      try { return [new URL(r.url).hostname]; } catch { return []; }
    });
  });
  const searched = diverseSeeds([...seeds], MAX_RIVAL_SERPS);
  const failed: string[] = [];
  const pages = await Promise.all(
    searched.map((term) => search(term).catch(() => { failed.push(term); return [] as string[]; })),
  );
  return { rivals: pickSerpRivals(pages, exclude), searched, failed };
}
