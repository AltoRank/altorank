import { diverseSeeds } from "./diversity";
// ---------------------------------------------------------------------------
// Where a new workspace's keyword candidates come from
// ---------------------------------------------------------------------------
//
// Two sources, both of which work for the site that actually signs up: a new
// domain with no rankings of its own.
//
//   competitors   what the rivals the person named in the wizard rank for
//                 today, top twenty, real volume. `ranked_keywords` on each,
//                 up to three. The previous source found rivals through
//                 DataForSEO's `competitors_domain`, which needs the site's
//                 OWN rankings to find anyone - so for every new domain it
//                 returned nobody, and the competitor list the wizard
//                 collected was never read.
//
//   buyer seeds   the phrases a buyer types, proposed from the business
//                 profile (`buyer-seeds.ts`), priced in one `keyword_overview`
//                 call, and the ones that price long-tailed with
//                 `keyword_suggestions`. The seed is the discovery; the
//                 suggestion call only returns phrases containing it, which
//                 is on-topic by construction when the seed is. Replaces
//                 heading n-grams as seeds and the Google Ads
//                 `keywords_for_site` fallback, which between them produced
//                 every keyword set this product has had to throw away.
//
// Measured 2026-09-11 before choosing: Labs `keyword_ideas` on the same seeds
// matched on shared words and led with "shopify", "police scanner app" and
// "anti virus scanning" at $0.017 a call. The overview priced five seeds for
// $0.012 and the suggestions on "packing slip template" were six rows, all of
// them the phrase.
//
// What the site already ranks for stays where it was, in `analyseDomain`: it
// is measured per page and feeds the striking-distance rule there.

import { fetchRankedKeywords } from "@/lib/seo/ranked-keywords";
import { discoverKeywordsFromSeeds, type DiscoveredKeyword } from "@/lib/seo/keywords";
import { classifyIntent } from "@/lib/seo/intent";
import { fetchTermMetrics } from "./metrics";
import { isBrandTerm } from "./seeds";
import { proposeBuyerSeeds, type BuyerSeeds, type SeedableProfile } from "./buyer-seeds";
import type { SpendSink } from "./buyer-model";

/** A candidate plus the rival that holds it, when one does. */
export type Candidate = DiscoveredKeyword & { competitor?: string };

export { isBrandTerm };

export interface DiscoveryResult {
  fromCompetitors: Candidate[];
  fromIdeas: Candidate[];
  seeds: BuyerSeeds;
  /** How many of the seeds anyone searches, for the run's trace. */
  seedsPriced: number;
  /** Which competitors were read, for the run's trace. */
  competitorsAsked: string[];
}

/** Rivals a first look reads. Each is one `ranked_keywords` task. */
export const MAX_COMPETITORS_READ = 3;
/** Rows per rival: the top of what they rank for is the market. */
export const ROWS_PER_COMPETITOR = 100;
/** A rival's position past this is not a keyword they own. */
export const COMPETITOR_MAX_RANK = 20;
/** Rivals rank for a lot of tiny things; this is the noise floor. */
export const COMPETITOR_MIN_VOLUME = 10;
/** A measured seed below this floor is excluded; unknown demand stays unknown. */
export const SEED_MIN_VOLUME = 10;
/** Diverse seeds expanded in profile order. One `keyword_suggestions` call each. */
export const MAX_EXPANDED_SEEDS = 5;
/** Rows across all expansions; the call divides it per seed. */
export const EXPANSION_LIMIT = 100;

const host = (d: string) => d.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();


export async function discoverBuyerKeywords(options: {
  domain: string;
  business: SeedableProfile | null;
  languageCode?: string;
  locationCode?: number;
  spend?: SpendSink | null;
}): Promise<DiscoveryResult> {
  const languageCode = options.languageCode ?? "en";
  const locale = { languageCode, locationCode: options.locationCode };
  const own = host(options.domain);
  const competitors = [...new Set((options.business?.competitors ?? []).map(host))]
    .filter((c) => c && c !== own)
    .slice(0, MAX_COMPETITORS_READ);
  const brand = (term: string) => isBrandTerm(term, options.domain, competitors);

  const [seeds, perCompetitor] = await Promise.all([
    proposeBuyerSeeds(options.business, { spend: options.spend }),
    Promise.all(
      competitors.map((c) =>
        fetchRankedKeywords(c, {
          ...locale,
          limit: ROWS_PER_COMPETITOR,
          minVolume: COMPETITOR_MIN_VOLUME,
          maxRank: COMPETITOR_MAX_RANK,
        }).catch(() => []),
      ),
    ),
  ]);

  const fromCompetitors: Candidate[] = [];
  const seen = new Set<string>();
  perCompetitor.forEach((rows, i) => {
    const byPage = new Map<string, number>();
    for (const k of rows) {
      const key = k.keyword.trim().toLowerCase();
      if (!key || seen.has(key) || brand(key)) continue;
      const page = k.url?.replace(/[?#].*$/, "");
      if (page && (byPage.get(page) ?? 0) >= 2) continue;
      if (page) byPage.set(page, (byPage.get(page) ?? 0) + 1);
      seen.add(key);
      fromCompetitors.push({
        keyword: k.keyword,
        volume: k.volume ?? 0,
        difficulty: k.difficulty,
        cpc: k.cpc ?? 0,
        competition: 0,
        intent: k.intent ?? classifyIntent(k.keyword, languageCode).intent,
        sourceUrl: k.url,
        competitor: competitors[i],
      });
    }
  });

  // The seeds themselves, priced. A seed anyone searches is a candidate in
  // its own right - "packing slip template" at 1,300 a month is the article -
  // and only those are worth a long-tail call.
  const fromIdeas: Candidate[] = [];
  const ideasSeen = new Set<string>();
  let seedsPriced = 0;
  if (seeds.seeds.length) {
    const priced = await fetchTermMetrics(seeds.seeds, locale).catch(() => new Map());
    const live: Candidate[] = [];
    for (const [term, m] of priced) {
      if ((m.volume !== null && m.volume < SEED_MIN_VOLUME) || brand(term)) continue;
      live.push({ keyword: term, volume: m.volume ?? 0, difficulty: m.difficulty, cpc: m.cpc ?? 0, competition: 0, intent: m.intent, unmeasured: m.volume === null });
    }
    // The seed order covers different buying jobs; volume must not erase it.
    const seedOrder = new Map(seeds.seeds.map((term, i) => [term, i]));
    live.sort((a, b) => (seedOrder.get(a.keyword) ?? 99) - (seedOrder.get(b.keyword) ?? 99));
    for (const term of seeds.seeds) {
      if (!priced.has(term) && !brand(term)) fromIdeas.push({ keyword: term, volume: 0, difficulty: null, cpc: 0, competition: 0, intent: classifyIntent(term, languageCode).intent, unmeasured: true });
    }
    seedsPriced = live.length;
    for (const k of live) {
      ideasSeen.add(k.keyword.toLowerCase());
      fromIdeas.push(k);
    }
    const expand = diverseSeeds(live.map((k) => k.keyword), MAX_EXPANDED_SEEDS);
    const tail = expand.length
      ? await discoverKeywordsFromSeeds(expand, { ...locale, limit: EXPANSION_LIMIT, maxSeeds: MAX_EXPANDED_SEEDS, minVolume: SEED_MIN_VOLUME }).catch(() => [])
      : [];
    for (const k of tail) {
      const key = k.keyword.trim().toLowerCase();
      if (!key || ideasSeen.has(key) || brand(key)) continue;
      ideasSeen.add(key);
      fromIdeas.push({ keyword: k.keyword, volume: k.volume, difficulty: k.difficulty, cpc: k.cpc, competition: k.competition, intent: k.intent });
    }
  }

  return { fromCompetitors, fromIdeas, seeds, seedsPriced, competitorsAsked: competitors };
}
