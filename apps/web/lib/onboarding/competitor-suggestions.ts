// ---------------------------------------------------------------------------
// Rivals the wizard proposes, and how big each one is
// ---------------------------------------------------------------------------
//
// The competitor box was the field that decided the first plan and the field
// most often left empty: the homepage names nobody (altorank.co: 0 of 7), or
// names the incumbents a founder mentions (fitsuite.co: Trainerize, TrueCoach,
// PT Distinction), which are the ones an "alternative" article cannot beat.
// The rivals worth a first article are the small ones, and only the founder
// knows those. So the box is pre-filled from what the machine can find, each
// suggestion says where it came from and whether the host is bigger than the
// site, and the person confirms, adds, or removes. At least one stays.
//
// Three sources, in the order shown:
//   site   - domains the profile model read on the homepage, already resolved
//   serp   - hosts vetted as sellers on the results pages for the buyer seeds
//            (lib/keyword-research/serp-rivals.ts); saved so discovery reuses
//   index  - DataForSEO's organic competitors of the site itself; empty for a
//            site with no rankings, which is most sites at signup

import type { BusinessProfile } from "./business-profile";
import { proposeBuyerSeeds } from "@/lib/keyword-research/buyer-seeds";
import { findSerpRivals } from "@/lib/keyword-research/serp-rivals";
import { isBrandTerm } from "@/lib/keyword-research/seeds";
import { fetchOrganicCompetitors, rankCompetitors } from "@/lib/seo/competitors";
import { fetchBulkAuthority } from "@/lib/seo/domain-metrics";
import type { SpendSink } from "@/lib/keyword-research/buyer-model";

export type SuggestionSource = "site" | "serp" | "index";
export type RivalSize = "bigger" | "similar" | "smaller";

export interface CompetitorSuggestion {
  domain: string;
  source: SuggestionSource;
  /** 0-100, null when unmeasured. */
  authority: number | null;
  /** Relative to the site. Null when either side is unmeasured. */
  size: RivalSize | null;
}

export interface CompetitorSuggestions {
  /** The site's own authority, 0-100, null when unmeasured. */
  own: number | null;
  suggestions: CompetitorSuggestion[];
  /** The vetted results-page rivals, for `business_profile.searchRivals`. */
  searchRivals: string[];
}

/** Keywords a host must share with the site before the index calls it a competitor. */
export const MIN_SHARED_KEYWORDS = 3;

/** Authority points between two hosts before one is called bigger or smaller. */
export const SIZE_MARGIN = 15;

/**
 * Bigger, similar or smaller than the site.
 *
 * A margin rather than a straight comparison: the number is one vendor's
 * estimate, and two hosts eight points apart are not different sizes. With
 * fitsuite.co at 42: revoo 22 smaller, qomodo 28 similar, evolutionfit 59
 * bigger, trainerize 70 bigger. Null when either side is unmeasured; the tag
 * is then simply absent, never a guess.
 */
export function classifyRivalSize(own: number | null, rival: number | null): RivalSize | null {
  if (own === null || rival === null) return null;
  if (rival >= own + SIZE_MARGIN) return "bigger";
  if (rival <= own - SIZE_MARGIN) return "smaller";
  return "similar";
}

const host = (d: string) => d.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();

/** One list, one entry per host, first source wins, own site never. */
export function mergeSuggestions(
  own: string,
  sources: ReadonlyArray<{ source: SuggestionSource; domains: readonly string[] }>,
): Array<{ domain: string; source: SuggestionSource }> {
  const self = host(own);
  const seen = new Set<string>();
  const out: Array<{ domain: string; source: SuggestionSource }> = [];
  for (const { source, domains } of sources) {
    for (const raw of domains) {
      const d = host(raw);
      if (!d || d === self || seen.has(d)) continue;
      seen.add(d);
      out.push({ domain: d, source });
    }
  }
  return out;
}

export async function suggestCompetitors(options: {
  domain: string;
  business: BusinessProfile;
  languageCode: string;
  locationCode: number;
  spend?: SpendSink | null;
}): Promise<CompetitorSuggestions> {
  const own = host(options.domain);
  const locale = { languageCode: options.languageCode, locationCode: options.locationCode };
  const named = options.business.competitors.map(host).filter(Boolean);

  const [serp, index] = await Promise.all([
    (async () => {
      const seeds = await proposeBuyerSeeds(options.business, { spend: options.spend });
      const searchable = seeds.seeds.filter((t) => !isBrandTerm(t, own, named));
      if (!searchable.length) return { rivals: [] as string[] };
      return findSerpRivals(searchable, locale, new Set([own, ...named]), { business: options.business, spend: options.spend });
    })().catch(() => ({ rivals: [] as string[] })),
    fetchOrganicCompetitors(own, { ...locale, limit: 20 })
      // A site with three rankings "shares keywords" with whoever holds one
      // of them: fitsuite.co's index competitors were a tech blog and a
      // running coach. Sharing one keyword is a coincidence; sharing several
      // is a market.
      .then((items) => rankCompetitors(own, items.filter((c) => c.sharedKeywords >= MIN_SHARED_KEYWORDS), 5).map((c) => c.domain))
      .catch(() => [] as string[]),
  ]);

  const merged = mergeSuggestions(own, [
    { source: "site", domains: named },
    { source: "serp", domains: serp.rivals },
    { source: "index", domains: index },
  ]);
  const authority = await fetchBulkAuthority([own, ...merged.map((m) => m.domain)]).catch(() => new Map<string, number | null>());
  const ownAuthority = authority.get(own) ?? null;
  return {
    own: ownAuthority,
    suggestions: merged.map((m) => {
      const a = authority.get(m.domain) ?? null;
      return { ...m, authority: a, size: classifyRivalSize(ownAuthority, a) };
    }),
    searchRivals: serp.rivals,
  };
}
