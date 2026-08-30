// ---------------------------------------------------------------------------
// What this business is actually about
// ---------------------------------------------------------------------------
//
// The keyword recommender scored opportunity (volume) against winnability
// (difficulty and current rank) and had no third axis for whether the keyword
// had anything to do with the client. On a live run it picked "ai book" for
// supalabs.co, an AI operations consultancy, and the generator produced "The AI
// Book Guide: Best Reads on Artificial Intelligence for Every Skill Level".
//
// Nothing caught it. The fact checker verifies claims, not relevance, and the
// article was perfectly true. That is the failure mode autonomy makes expensive:
// confident, well-researched, on-brand-voice content about the wrong subject,
// which still costs a human the time to read and reject.
//
// The raw material was already there. The first-look analysis crawls up to 40
// pages of the site, so the product knows what the client writes about; it just
// never used it to decide what to write next.
//
// Deterministic and free, like the rest of the scoring: same site in, same
// profile out, and a human can read why a keyword was rejected.

import type { CrawlResult } from "@/lib/audit/crawler";
import { decodeEntities } from "@/lib/audit/html-utils";

export interface TopicalProfile {
  domain: string;
  /** Term -> weight. The vocabulary that characterises this business. */
  terms: Record<string, number>;
  /** Strongest terms, for showing a human what the profile understood. */
  topTerms: string[];
  pagesAnalysed: number;
  builtAt: string;
}

export interface RelevanceScore {
  /** 0-1. 1 means every content word is vocabulary this site actually uses. */
  score: number;
  matched: string[];
  unmatched: string[];
  reason: string;
}

/** Field weights: a term in a title says more than one in a subheading. */
const WEIGHTS = { title: 3, h1: 3, metaDescription: 1.5, h2: 2 } as const;

/**
 * A term appearing in more than this share of text fragments is treated as
 * boilerplate and dropped.
 *
 * This replaces a hand-written stopword list, and it is the reason the module
 * needs no vocabulary maintenance. Function words ("the", "and", "we") and site
 * furniture ("home", "contact", "privacy") share one measurable property: they
 * appear almost everywhere, so they cannot distinguish this site from any
 * other. Words that describe the business appear in a minority of fragments.
 *
 * It works in any language without a per-language list, which matters because
 * this product ships 36 locales and a curated English list would have silently
 * produced garbage profiles for the other 35.
 *
 * Fragments, not pages, are the unit: every title, heading and meta description
 * counts separately. A four-page site still yields dozens of fragments, so the
 * frequency signal survives on small sites where a per-page count would not.
 */
const BOILERPLATE_SHARE = 0.25;

/**
 * Below this many fragments, "appears in half of them" means nothing, so
 * filtering is skipped rather than applied to noise.
 */
const MIN_FRAGMENTS_FOR_FILTERING = 8;

/**
 * Split into candidate terms.
 *
 * Entities are decoded rather than blocklisted. The crawler stores raw text, so
 * "don&#x27;t" and "R&amp;D" previously tokenised to "x27" and "amp", and both
 * ranked in a real site's top ten terms. Decoding fixes the cause; a list of
 * known fragments would only have covered the ones already seen.
 */
function tokenize(text: string): string[] {
  return decodeEntities(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2 && t.length < 30 && !/^\d+$/.test(t));
}

/**
 * Build a vocabulary profile from crawled pages.
 *
 * Uses titles, headings and meta descriptions rather than body text. Body copy
 * is mostly navigation, footers and legal boilerplate, which is near-identical
 * across sites and would dilute the signal; headings are what the business
 * chose to say it does.
 */
export function buildTopicalProfile(
  domain: string,
  pages: CrawlResult[],
  now: string = new Date().toISOString(),
): TopicalProfile {
  // Each text fragment is a document, which is what makes the frequency filter
  // below work on sites with only a handful of pages.
  const fragments: Array<{ text: string; weight: number }> = [];

  for (const page of pages) {
    if (page.title) fragments.push({ text: page.title, weight: WEIGHTS.title });
    if (page.metaDescription) {
      fragments.push({ text: page.metaDescription, weight: WEIGHTS.metaDescription });
    }
    for (const h of page.h1 ?? []) if (h) fragments.push({ text: h, weight: WEIGHTS.h1 });
    for (const h of page.h2 ?? []) if (h) fragments.push({ text: h, weight: WEIGHTS.h2 });
  }

  const weighted: Record<string, number> = {};
  const fragmentCount: Record<string, number> = {};

  for (const { text, weight } of fragments) {
    const tokens = tokenize(text);
    for (const token of tokens) weighted[token] = (weighted[token] ?? 0) + weight;
    // Count each term once per fragment, so a word repeated inside one heading
    // does not look like a word used all over the site.
    for (const token of new Set(tokens)) {
      fragmentCount[token] = (fragmentCount[token] ?? 0) + 1;
    }
  }

  const filter = fragments.length >= MIN_FRAGMENTS_FOR_FILTERING;
  const terms: Record<string, number> = {};

  for (const [token, weight] of Object.entries(weighted)) {
    const share = fragmentCount[token] / fragments.length;
    if (filter && share > BOILERPLATE_SHARE) continue; // nav, footer, function words

    // Inverse document frequency, the standard weighting for exactly this.
    //
    // A linear (1 - share) damping was not enough: common words also occur many
    // times, so raw frequency still floated "the", "and" and "not" into the top
    // terms for a real site. IDF is logarithmic in rarity, so a word in 2% of
    // fragments outweighs one in 40% by roughly four to one rather than by a
    // few percent.
    const idf = Math.log(fragments.length / fragmentCount[token]);
    // Sublinear term frequency, the other half of standard TF-IDF.
    //
    // Multiplying raw frequency by IDF was not enough on real sites: a function
    // word occurs so many times that its count alone outweighs a fourfold IDF
    // advantage, and "the", "and" and "not" still topped the profile. Damping
    // frequency logarithmically means saying a word twenty times is worth a
    // little more than saying it ten times, not twice as much, which is what
    // lets a rare product word outrank common filler.
    const distinctiveness = Math.log(1 + weight) * idf;
    // A term in every fragment has idf 0 and carries no signal. Keeping it
    // would let a keyword "match" against a word that describes nothing.
    if (distinctiveness <= 0) continue;
    terms[token] = distinctiveness;
  }

  // The domain name is a strong signal and often absent from the copy, so it is
  // added after filtering rather than competing in it.
  for (const token of tokenize(domain.replace(/\.[a-z.]+$/i, "").replace(/[.-]/g, " "))) {
    terms[token] = (terms[token] ?? 0) + WEIGHTS.title;
  }

  const topTerms = Object.entries(terms)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([t]) => t);

  return { domain, terms, topTerms, pagesAnalysed: pages.length, builtAt: now };
}

/**
 * How much a keyword looks like something this business would write about.
 *
 * Scores on the fraction of content words the site's own vocabulary contains.
 * The signal that matters is the UNMATCHED word: "ai book" and "ai native" both
 * match "ai", and the whole difference is that the site says "native" all over
 * its homepage and never says "book".
 *
 * Returns 1 (neutral) when there is no profile. A workspace whose crawl failed
 * should not have every keyword suppressed; the absence of evidence is not
 * evidence of irrelevance.
 */
export function scoreRelevance(
  keyword: string,
  profile: TopicalProfile | null | undefined,
): RelevanceScore {
  if (!profile || !Object.keys(profile.terms).length) {
    return {
      score: 1,
      matched: [],
      unmatched: [],
      reason: "no topical profile for this site; relevance not scored",
    };
  }

  const tokens = tokenize(keyword);
  if (!tokens.length) {
    return {
      score: 0.5,
      matched: [],
      unmatched: [],
      reason: "keyword has no content words",
    };
  }

  // Matches count for as much as the term is distinctive.
  //
  // The frequency filter cannot catch everything: in short titles and headings
  // a word like "the" appears in well under half of them, so it survives with a
  // low weight. Counting every match equally would then let "the best crm"
  // score as a partial match on any site whose copy contains "the". Scaling by
  // weight against the profile's median makes that match worth almost nothing
  // while a match on a real product word counts fully, with no word list.
  const weights = Object.values(profile.terms).sort((a, b) => a - b);
  const median = weights[Math.floor(weights.length / 2)] || 1;

  const strengthOf = (token: string): number => {
    const direct = profile.terms[token];
    if (direct !== undefined) return Math.min(1, direct / median);

    // Accept a stem match so "agencies" finds "agency" and "operations" finds
    // "operational". Crude, but it has to hold across 36 locales.
    let best = 0;
    for (const [term, weight] of Object.entries(profile.terms)) {
      const stemMatch =
        (term.length > 4 && token.startsWith(term.slice(0, Math.max(4, term.length - 2)))) ||
        (token.length > 4 && term.startsWith(token.slice(0, Math.max(4, token.length - 2))));
      if (stemMatch) best = Math.max(best, Math.min(1, weight / median));
    }
    return best;
  };

  const matched: string[] = [];
  const unmatched: string[] = [];
  let total = 0;

  for (const token of tokens) {
    const strength = strengthOf(token);
    total += strength;
    // Below a token of real signal, treat it as absent for reporting: a word
    // that only matched site furniture is not evidence of relevance.
    (strength >= 0.25 ? matched : unmatched).push(token);
  }

  const score = total / tokens.length;

  return {
    score,
    matched,
    unmatched,
    reason: unmatched.length
      ? `${unmatched.map((t) => `"${t}"`).join(", ")} ${unmatched.length === 1 ? "does" : "do"} not appear anywhere on the site`
      : "every word appears in the site's own vocabulary",
  };
}
