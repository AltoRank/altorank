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

import { categoryCandidates, pickCategory } from "./seeds";
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
