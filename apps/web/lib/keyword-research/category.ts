// ---------------------------------------------------------------------------
// The category a business belongs to, as the market names it
// ---------------------------------------------------------------------------
//
// `categoryOf` reads the description and returns its first noun pair. That
// pair is the company's tagline more often than the market's term: "scan-driven
// packout" for packhub.io, "appointment-based websites" for qasimcode.com.
// Seeds built on a tagline price at zero and buy nothing, and the run falls
// through to the ads tool reading words off the homepage.
//
// This asks the provider which of the description's candidates anyone
// searches for. One keyword_overview call for a handful of terms - about a
// cent - on paths that are already paid (the first look, a pool refill).

import { categoryCandidates, pickCategory, categoryHead, audienceSeeds, type SubjectFields } from "./seeds";
import { fetchTermMetrics } from "./metrics";
import { MIN_VOLUME } from "./funnel";

export type PriceTerms = (terms: string[]) => Promise<ReadonlyMap<string, { volume: number | null }>>;

export interface ResolvedCategory {
  category: string | null;
  /** True when a provider confirmed somebody searches for it. */
  priced: boolean;
  volume: number | null;
  candidates: string[];
}

export async function resolveCategory(
  profile: { description?: string | null } | null | undefined,
  brand: string | null | undefined,
  options: { price?: PriceTerms; languageCode?: string; locationCode?: number } = {},
): Promise<ResolvedCategory> {
  if (!profile?.description) return { category: null, priced: false, volume: null, candidates: [] };
  const candidates = categoryCandidates({ description: profile.description ?? "" }, brand);
  if (!candidates.length) return { category: null, priced: false, volume: null, candidates };

  const price: PriceTerms =
    options.price ??
    ((terms) => fetchTermMetrics(terms, { languageCode: options.languageCode, locationCode: options.locationCode }));

  let metrics: ReadonlyMap<string, { volume: number | null }>;
  try {
    metrics = await price(candidates);
  } catch {
    // The provider is down or unconfigured: the first guess, as before.
    return { category: candidates[0], priced: false, volume: null, candidates };
  }
  const category = pickCategory(candidates, metrics, MIN_VOLUME);
  const volume = category ? (metrics.get(category.toLowerCase())?.volume ?? null) : null;
  return { category, priced: volume !== null && volume >= MIN_VOLUME, volume, candidates };
}


// ---------------------------------------------------------------------------
// The head the seeds are built on
// ---------------------------------------------------------------------------
//
// `resolveCategory` picks the description's phrase with the most search
// volume on its own. That turned out to be the wrong question for seeding.
// qasimcode.com's phrase with the most volume is "online booking" (27,100/mo);
// composed with its audiences - "dental clinic online booking", "salon online
// booking" - every seed prices at zero, where the old head "website" gave
// "dental clinic website" 30/mo and "appointment booking website" 210/mo. A
// feature has volume; the noun that pairs with a buyer is what a seed needs.
// packhub.io's winner was "put wall", a real warehouse term that composes with
// nothing. Both sites stored zero audience or profile keywords on 2026-09-10
// and the ads tool filled their pools.
//
// So the head is chosen by how its COMPOSED seeds price: every candidate head
// is paired with every audience, the lot is priced in one call, and the head
// whose seeds carry the most volume wins. Nothing prices: the old head, which
// is what worked before any of this.

export interface ResolvedHead {
  head: string | null;
  /** True when the winning head's composed seeds carried search volume. */
  priced: boolean;
  /** Volume across the winning head's seeds. */
  seedVolume: number;
  /** What was tried, best first, with the volume its seeds carried. */
  tried: { head: string; seedVolume: number }[];
}

export async function resolveSeedHead(
  business: SubjectFields | null | undefined,
  profile: { topTerms?: string[] | null } | null | undefined,
  domain: string,
  options: { price?: PriceTerms; languageCode?: string; locationCode?: number; maxHeads?: number } = {},
): Promise<ResolvedHead> {
  const none: ResolvedHead = { head: null, priced: false, seedVolume: 0, tried: [] };
  if (!business?.audiences?.length) return none;

  const brand = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const fallback = categoryHead(business, profile, domain);
  const heads = [
    ...(fallback ? [fallback] : []),
    ...categoryCandidates({ description: business.description ?? "" }, brand, options.maxHeads ?? 5),
  ].map((h) => h.trim().toLowerCase()).filter((h, i, a) => h && a.indexOf(h) === i);
  if (!heads.length) return none;

  const seedsOf = new Map(heads.map((h) => [h, audienceSeeds(business, profile, domain, h).map((s) => s.seed)]));
  const all = [...new Set([...seedsOf.values()].flat())];
  if (!all.length) return { ...none, head: fallback };

  const price: PriceTerms =
    options.price ??
    ((terms) => fetchTermMetrics(terms, { languageCode: options.languageCode, locationCode: options.locationCode }));
  let metrics: ReadonlyMap<string, { volume: number | null }>;
  try {
    metrics = await price(all);
  } catch {
    return { head: fallback, priced: false, seedVolume: 0, tried: heads.map((head) => ({ head, seedVolume: 0 })) };
  }

  const tried = heads
    .map((head) => ({
      head,
      seedVolume: (seedsOf.get(head) ?? []).reduce((sum, t) => sum + (metrics.get(t.toLowerCase())?.volume ?? 0), 0),
    }))
    // Stable: the order the heads were offered in breaks ties, and the old
    // head is offered first.
    .sort((a, b) => b.seedVolume - a.seedVolume);
  const best = tried[0];
  if (!best || best.seedVolume <= 0) return { head: fallback, priced: false, seedVolume: 0, tried };
  return { head: best.head, priced: true, seedVolume: best.seedVolume, tried };
}
