import { diverseSeeds } from "./diversity";
// Discovery combines named competitors' rankings with buyer-category seeds.
// Exact metrics guide expansion but absence from the index is not zero demand.
// Weak coverage gets one short-category recovery pass and at most five total
// suggestions probes. Buyer fit and live editorial SERP qualification run later:
// a measured keyword is still only a candidate, never approval to write.

import { fetchRankedKeywords } from "@/lib/seo/ranked-keywords";
import { discoverKeywordsFromSeeds, type DiscoveredKeyword } from "@/lib/seo/keywords";
import { classifyIntent } from "@/lib/seo/intent";
import { fetchTermMetrics } from "./metrics";
import { isBrandTerm } from "./seeds";
import { proposeBuyerSeeds, recoverBuyerSeeds, type BuyerSeeds, type SeedableProfile } from "./buyer-seeds";
import type { SpendSink } from "./buyer-model";
import { findSerpRivals } from "./serp-rivals";
import { resolveCompetitorDomains } from "@/lib/onboarding/competitor-domains";

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
  /** Rivals read off the results pages for the buyer seeds, and how many rows they gave. */
  serpRivals: string[];
  fromSerpRivals: number;
  /** Seeds whose rival search errored. */
  serpRivalSearchesFailed: string[];
  /** Names no domain could be found for; never queried. */
  competitorsUnresolved: string[];
  /** Rivals whose read errored, as opposed to returning nothing. */
  competitorsFailed: string[];
  /** Recovery and expansion evidence; missing metrics never imply zero demand. */
  seedRecovery: { attempted: boolean; seeds: string[]; measured: number };
  expandedSeeds: string[];
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
  // Profiles saved before names were resolved at the wizard, and anything
  // typed by hand, can still hold "trainerize". A name is resolved here and
  // what cannot be placed is reported rather than sent to `ranked_keywords`.
  const named = await resolveCompetitorDomains(
    (options.business?.competitors ?? []).slice(0, MAX_COMPETITORS_READ * 2),
  ).catch(() => ({ domains: [] as string[], unresolved: [] as string[] }));
  const competitors = [...new Set(named.domains.map(host))]
    .filter((c) => c && c !== own)
    .slice(0, MAX_COMPETITORS_READ);
  const competitorsFailed: string[] = [];
  // Grows when rivals are read off the results pages: their brand names are
  // navigation for them, the same as a named rival's.
  const rivalsKnown = [...competitors];
  const brand = (term: string) => isBrandTerm(term, options.domain, rivalsKnown);

  const [seeds, perCompetitor] = await Promise.all([
    proposeBuyerSeeds(options.business, { spend: options.spend }),
    Promise.all(
      competitors.map((c) =>
        fetchRankedKeywords(c, {
          ...locale,
          limit: ROWS_PER_COMPETITOR,
          minVolume: COMPETITOR_MIN_VOLUME,
          maxRank: COMPETITOR_MAX_RANK,
        }).catch(() => {
          // A provider error is not "this rival ranks for nothing".
          competitorsFailed.push(c);
          return [];
        }),
      ),
    ),
  ]);

  const fromCompetitors: Candidate[] = [];
  const seen = new Set<string>();
  const absorb = (rows: Awaited<ReturnType<typeof fetchRankedKeywords>>, competitor: string) => {
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
        competitor,
      });
    }
  };
  perCompetitor.forEach((rows, i) => absorb(rows, competitors[i]));

  // The rivals that hold this site's results pages, in its own locale. Read
  // after the seeds exist because the seeds are what is searched.
  const serpRivals = seeds.seeds.length
    ? await findSerpRivals(
        seeds.seeds.filter((t) => !brand(t)),
        // Same market `fetchRankedKeywords` reads when none is set, so the rivals
        // found and the rows read for them come from one results index.
        { languageCode, locationCode: options.locationCode ?? 2840 },
        new Set([own, ...competitors]),
      )
    : { rivals: [] as string[], searched: [] as string[], failed: [] as string[] };
  const perSerpRival = await Promise.all(
    serpRivals.rivals.map((c) =>
      fetchRankedKeywords(c, {
        ...locale,
        limit: ROWS_PER_COMPETITOR,
        minVolume: COMPETITOR_MIN_VOLUME,
        maxRank: COMPETITOR_MAX_RANK,
      }).catch(() => {
        competitorsFailed.push(c);
        return [];
      }),
    ),
  );
  rivalsKnown.push(...serpRivals.rivals);
  const namedRows = fromCompetitors.length;
  perSerpRival.forEach((rows, i) => absorb(rows, serpRivals.rivals[i]));
  const fromSerpRivals = fromCompetitors.length - namedRows;

  const fromIdeas: Candidate[] = [];
  const seedRecovery = { attempted: false, seeds: [] as string[], measured: 0 };
  let expandedSeeds: string[] = [];
  let seedsPriced = 0;
  if (seeds.seeds.length) {
    const priced = await fetchTermMetrics(seeds.seeds, locale).catch(() => new Map());
    const measured = (terms: string[]) => terms.filter((term) => {
      const m = priced.get(term);
      return m?.volume != null && m.volume >= SEED_MIN_VOLUME && !brand(term);
    });
    // One extra model call and one overview batch, only when coverage is weak.
    // All candidates still pass buyer fit and live editorial SERP qualification.
    if (measured(seeds.seeds).length < 3) {
      seedRecovery.attempted = true;
      seedRecovery.seeds = await recoverBuyerSeeds(options.business, seeds.seeds, { spend: options.spend });
      if (seedRecovery.seeds.length) {
        const recovered = await fetchTermMetrics(seedRecovery.seeds, locale).catch(() => new Map());
        for (const [term, metric] of recovered) priced.set(term, metric);
        seedRecovery.measured = measured(seedRecovery.seeds).length;
      }
    }
    const allSeeds = [...seeds.seeds, ...seedRecovery.seeds];
    const live = measured(allSeeds);
    seedsPriced = live.length;
    // Missing overview data does not prevent a bounded suggestions probe.
    // Prefer short recovery categories when none were measured; never probe a
    // seed whose volume was explicitly measured below the floor.
    const unknown = [...seedRecovery.seeds, ...seeds.seeds].filter((term) =>
      !brand(term) && priced.get(term)?.volume == null,
    );
    const knownExpansion = diverseSeeds(live, MAX_EXPANDED_SEEDS);
    expandedSeeds = [...knownExpansion, ...diverseSeeds(unknown, MAX_EXPANDED_SEEDS - knownExpansion.length)]
      .slice(0, MAX_EXPANDED_SEEDS);
    const ideas = new Map<string, Candidate>();
    for (const term of [...live, ...unknown]) {
      const m = priced.get(term);
      ideas.set(term, {
        keyword: term, volume: m?.volume ?? 0, difficulty: m?.difficulty ?? null,
        cpc: m?.cpc ?? 0, competition: 0,
        intent: m?.intent ?? classifyIntent(term, languageCode).intent,
        unmeasured: m?.volume == null,
      });
    }
    const tail = expandedSeeds.length
      ? await discoverKeywordsFromSeeds(expandedSeeds, { ...locale, limit: EXPANSION_LIMIT, maxSeeds: MAX_EXPANDED_SEEDS, minVolume: SEED_MIN_VOLUME }).catch(() => [])
      : [];
    for (const k of tail) {
      const key = k.keyword.trim().toLowerCase();
      if (!key || brand(key)) continue;
      // A suggestions measurement replaces an unknown overview candidate.
      if (!ideas.has(key) || (ideas.get(key)?.unmeasured && !k.unmeasured)) ideas.set(key, k);
    }
    // Measured discovery comes first; a missing metric remains explicit.
    fromIdeas.push(...[...ideas.values()].sort((a, b) => Number(Boolean(a.unmeasured)) - Number(Boolean(b.unmeasured))));
  }

  return { fromCompetitors, fromIdeas, seeds, seedsPriced, competitorsAsked: competitors, competitorsUnresolved: named.unresolved, competitorsFailed, serpRivals: serpRivals.rivals, fromSerpRivals, serpRivalSearchesFailed: serpRivals.failed, seedRecovery, expandedSeeds };
}
