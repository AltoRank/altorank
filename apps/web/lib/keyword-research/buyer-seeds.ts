// ---------------------------------------------------------------------------
// What a buyer types, proposed from the business profile
// ---------------------------------------------------------------------------
//
// The seeds a first look expands used to be n-grams of the site's headings
// plus "<audience> <category head>" compositions. Headings say more than the
// business ("other countries" came out of a page listing markets, and the
// first article ever written for that customer was about geography), and the
// compositions only work when the head prices - "dental clinic online
// booking" is a phrase nobody searches.
//
// A model reading the profile the person just confirmed does the job the
// heuristics were approximating: it knows that a warehouse app's buyer
// searches "packing slip template" and "order picking software", not
// "shipping". One call, the cheap tier, a dozen phrases. When there is no
// model the audiences and offerings are used as they were typed, which is
// weaker but honest.

import type { SpendSink } from "./buyer-model";
import { askStructured, describeBusiness, extractJson, modelAvailable } from "./buyer-model";

export const MAX_BUYER_SEEDS = 15;

export interface BuyerSeeds {
  seeds: string[];
  /** Where they came from, for the run's trace. */
  basis: "model" | "profile" | "none";
}

export interface SeedableProfile {
  name?: string | null;
  description?: string | null;
  audiences?: string[] | null;
  offerings?: string[] | null;
  competitors?: string[] | null;
  buyingJobs?: string[] | null;
  differentiators?: string[] | null;
  exclusions?: string[] | null;
  conversionUrl?: string | null;
  country?: string | null;
  language?: string | null;
}

const PROMPT = [
  "You are doing keyword research for the business below.",
  "List the searches a person types into Google when they are looking for what this business sells,",
  "or trying to solve the problem it solves, and do not yet know this business exists.",
  "",
  "Rules:",
  "- 10 to 15 phrases, 2 to 8 words each, lowercase, in the language the site is written in.",
  "- Product and service categories, the problems they solve, comparisons and alternatives, how-to questions a buyer asks.",
  "- Include relevant competitor alternatives, comparisons and migration searches; exclude pure brand navigation. Cover different offerings, audiences and buying jobs rather than synonyms of one category.",
  "- Never a one-word head term. \"shipping\" is not a search a buyer of a packing app makes; \"packing slip template\" is.",
  "- Nothing a consumer types for personal use unless consumers are who this business sells to.",
  "",
  "Return ONLY a JSON array of strings, no prose, no code fence.",
].join("\n");

/** Exported for tests: the reply to a seed list, cleaned. */
export function parseSeeds(raw: string | null): string[] {
  const arr = extractJson<unknown>(raw, "[", "]");
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const s = v.trim().toLowerCase().replace(/\s+/g, " ");
    const words = s.split(" ").filter(Boolean);
    if (words.length < 2 || words.length > 8 || s.length < 4) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_BUYER_SEEDS) break;
  }
  return out;
}

/** The seeds a profile yields with no model: what the person typed, as typed. */
export function seedsFromProfile(business: SeedableProfile | null): string[] {
  if (!business) return [];
  const raw = [...(business.offerings ?? []), ...(business.audiences ?? [])];
  return parseSeeds(JSON.stringify(raw));
}

export async function proposeBuyerSeeds(
  business: SeedableProfile | null,
  options: { spend?: SpendSink | null } = {},
): Promise<BuyerSeeds> {
  if (!business || !(business.description?.trim() || business.offerings?.length || business.audiences?.length)) {
    return { seeds: [], basis: "none" };
  }
  if (modelAvailable()) {
    const prompt = `${PROMPT}\n\nBUSINESS\n${describeBusiness(business)}${business.language ? `\nSite language: ${business.language}` : ""}`;
    const seeds = parseSeeds(await askStructured("keyword-research/buyer-seeds", prompt, { maxTokens: 600, spend: options.spend }));
    if (seeds.length) return { seeds, basis: "model" };
  }
  const seeds = seedsFromProfile(business);
  return { seeds, basis: seeds.length ? "profile" : "none" };
}
