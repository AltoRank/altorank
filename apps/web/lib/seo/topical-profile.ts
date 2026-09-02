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
/** A homepage-headline word may exceed BOILERPLATE_SHARE up to here. */
const SIGNATURE_MAX_SHARE = 0.6;
/** Weight multiplier for words in the homepage title and h1. */
const SIGNATURE_BOOST = 3;

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
// Function words that survive the frequency filter in short titles and
// headings. The median weighting in scoreRelevance already makes them nearly
// worthless as matches; dropping them here keeps them out of the profile and
// out of the "on-topic: agency, for, seo" reasons a reviewer reads. English
// plus the handful that recur across the other locales' navigation.
const STOPWORDS = new Set([
  "and", "are", "for", "the", "you", "your", "with", "that", "this", "from", "how", "what",
  "why", "when", "who", "can", "any", "all", "our", "not", "but", "one", "get", "use",
  "und", "der", "die", "das", "für", "mit", "per", "con", "che", "del", "les", "des", "pour",
  // Website furniture and call-to-action verbs. They top a heading-based
  // profile on any site ("Learn more", "See how", "Next step", "Case studies")
  // and say nothing about what the business does. www.lully.ai's profile led
  // with "study, case, more, keep, see, next, step" before this list existed.
  "more", "learn", "see", "keep", "next", "step", "steps", "here", "now", "today",
  "home", "about", "contact", "schedule", "resources", "resource", "articles", "article",
  "blog", "news", "faq", "faqs", "privacy", "policy", "terms",
  "case", "study", "studies", "much", "also", "just", "into", "than", "them", "they",
  "will", "have", "has", "been", "let", "lets", "hear", "peers",
]);

/**
 * Seed phrases for keyword discovery, from the page text that names what the
 * site does: titles, h1s and h2s. Two- and three-word phrases with no
 * stopword in them, counted across pages, title and h1 weighted above h2.
 *
 * Single tokens are not seeds. "case" seeded the keyword tool with US court
 * records; "warehouse orchestration" seeds it with the site's actual market.
 */
export function seedPhrasesFromPages(
  pages: Array<{ title?: string | null; h1?: string[] | null; h2?: string[] | null }>,
  domain?: string,
  limit = 8,
): string[] {
  const brand = new Set(domain ? domainTokens(domain) : []);
  const score: Record<string, number> = {};
  const add = (text: string | null | undefined, weight: number) => {
    if (!text) return;
    // Split on punctuation and separators first so a phrase never crosses
    // "Warehouse Orchestration - Lully.ai" or "Effortlessly Adaptive. Endlessly".
    for (const clause of decodeEntities(text).split(/[|:;,.!?()\[\]"“”\-–—/]+/)) {
      const toks = clause.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      for (let n = 3; n >= 2; n--) {
        for (let i = 0; i + n <= toks.length; i++) {
          const gram = toks.slice(i, i + n);
          if (gram.some((t) => t.length < 3 || STOPWORDS.has(t) || brand.has(t) || /^\d+$/.test(t))) continue;
          // A phrase of only everyday words is a slogan, not a topic:
          // "all the answers are correct" seeded the keyword tool for
          // supalabs.co and brought back 6,600 searches of nothing.
          if (gram.every((t) => GENERIC_MATCH.has(t))) continue;
          const key = gram.join(" ");
          score[key] = (score[key] ?? 0) + weight * (n === 3 ? 1.2 : 1);
        }
      }
    }
  };
  for (const p of pages) {
    add(p.title, 3);
    for (const h of p.h1 ?? []) add(h, 3);
    for (const h of p.h2 ?? []) add(h, 1);
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  // Drop a bigram that only exists inside a higher-ranked trigram.
  const out: string[] = [];
  for (const phrase of ranked) {
    if (out.some((o) => o.includes(phrase) || phrase.includes(o))) continue;
    out.push(phrase);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The brand words in a hostname: "www.lully.ai" -> ["lully"],
 * "shop.acme-tools.co.uk" -> ["shop", "acme", "tools"]. The previous regex,
 * /\.[a-z.]+$/, stripped everything after the FIRST dot, so www.lully.ai
 * became "www" and every profile on a www. site carried "www" as its brand.
 */
export function domainTokens(domain: string): string[] {
  const host = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  // Drop the public suffix: the last label, and a second one when it is a
  // two-letter country code behind a generic label (co.uk, com.au).
  let keep = labels.slice(0, -1);
  if (keep.length >= 2 && /^(co|com|net|org|ac|gov|edu)$/.test(keep[keep.length - 1]) && labels[labels.length - 1].length === 2) {
    keep = keep.slice(0, -1);
  }
  return tokenize(keep.join(" ").replace(/[-_]/g, " "));
}

// Two-letter tokens that are words in this market, not fragments. Without
// this "AI-Driven Warehouse Orchestration" profiles as "driven warehouse
// orchestration" and every "ai …" keyword is judged on its other word alone.
const ACRONYMS = new Set(["ai", "ml", "ux", "ui", "hr", "vr", "ar", "3d", "5g", "b2b", "b2c", "cx", "erp", "crm", "wms", "tms", "3pl"]);

function tokenize(text: string): string[] {
  return decodeEntities(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => (t.length > 2 || ACRONYMS.has(t)) && t.length < 30 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
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

  // The first page's title and h1 are the positioning. A word there is never
  // boilerplate however often it recurs: "warehouse" sat in a quarter of
  // www.lully.ai's headings, because it is what the company does, and the
  // share filter dropped it as navigation.
  const first = pages[0];
  const signature = new Set<string>(first ? [...tokenize(first.title ?? ""), ...(first.h1 ?? []).flatMap((h) => tokenize(h))] : []);

  for (const [token, weight] of Object.entries(weighted)) {
    const share = fragmentCount[token] / fragments.length;
    // Signature words are exempt only while they are common, not universal:
    // a word in every fragment is the nav bar even when it sits in the h1.
    const positioning = signature.has(token) && share <= SIGNATURE_MAX_SHARE;
    if (filter && share > BOILERPLATE_SHARE && !positioning) continue; // nav, footer, function words

    // Inverse document frequency, the standard weighting for exactly this.
    //
    // A linear (1 - share) damping was not enough: common words also occur many
    // times, so raw frequency still floated "the", "and" and "not" into the top
    // terms for a real site. IDF is logarithmic in rarity, so a word in 2% of
    // fragments outweighs one in 40% by roughly four to one rather than by a
    // few percent.
    // A signature word in every fragment would have idf 0; floor it so the
    // positioning word survives with real weight.
    const idf = Math.max(positioning ? 0.5 : 0, Math.log(fragments.length / fragmentCount[token]));
    // Sublinear term frequency, the other half of standard TF-IDF.
    //
    // Multiplying raw frequency by IDF was not enough on real sites: a function
    // word occurs so many times that its count alone outweighs a fourfold IDF
    // advantage, and "the", "and" and "not" still topped the profile. Damping
    // frequency logarithmically means saying a word twenty times is worth a
    // little more than saying it ten times, not twice as much, which is what
    // lets a rare product word outrank common filler.
    // The homepage headline says what the business is; a case-study page
    // says who one customer was. TF-IDF cannot tell them apart and rewards
    // the rarer one, so www.lully.ai profiled as "fst, waco, shoe, company"
    // above "warehouse". The signature multiplier puts positioning first.
    const distinctiveness = Math.log(1 + weight) * idf * (signature.has(token) ? SIGNATURE_BOOST : 1);
    // A term in every fragment has idf 0 and carries no signal. Keeping it
    // would let a keyword "match" against a word that describes nothing.
    if (distinctiveness <= 0) continue;
    terms[token] = distinctiveness;
  }

  // The domain name is a strong signal and often absent from the copy, so it is
  // added after filtering rather than competing in it.
  for (const token of domainTokens(domain)) {
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
/** Words that shape a query without naming its subject. Never counted as
 *  evidence for or against relevance. */
const QUALIFIERS = new Set([
  "best", "top", "guide", "guides", "software", "tool", "tools", "system", "systems", "platform",
  "platforms", "management", "manager", "service", "services", "pricing", "price", "prices", "cost",
  "costs", "review", "reviews", "alternative", "alternatives", "solution", "solutions", "company",
  "companies", "provider", "providers", "example", "examples", "template", "templates", "checklist",
  "definition", "meaning", "benefits", "types", "list", "comparison", "online", "free", "cheap",
  "small", "medium", "large", "enterprise", "agency", "agencies", "how", "what", "why", "when",
  "tips", "ideas", "strategy", "strategies", "process", "processes", "automation", "automated",
  "using", "use", "uses", "vendor", "vendors", "app", "apps", "api", "apis", "2024", "2025", "2026",
]);

/**
 * Everyday words. Kept in the profile, because "Stop adding AI. Start
 * operating differently." is supalabs.co's actual positioning line, but a
 * seed phrase made only of these is a slogan, not a topic.
 */
const GENERIC_MATCH = new Set([
  "stop", "start", "starting", "add", "adding", "make", "makes", "making", "made",
  "work", "working", "works", "more", "less", "better", "best", "good", "great",
  "new", "get", "getting", "use", "used", "using", "keep", "keeping", "are", "you",
  "your", "we", "our", "all", "answers", "answer", "correct", "right", "wrong",
  "different", "differently", "operating", "operate", "run", "running", "way",
  "why", "how", "what", "when", "where", "who", "top", "big", "small", "real",
]);

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

  // A content noun the site never uses is a different topic, whatever the
  // other words do: "ai book" for an AI consultancy is a book query. Words
  // that qualify a topic rather than name one ("best", "management",
  // "pricing", "software") are free, or "warehouse management system" would
  // fail on "management".
  const foreign = unmatched.filter((t) => !QUALIFIERS.has(t) && strengthOf(t) === 0);
  const score = foreign.length ? 0 : total / tokens.length;

  return {
    score,
    matched,
    unmatched,
    reason: unmatched.length
      ? `${unmatched.map((t) => `"${t}"`).join(", ")} ${unmatched.length === 1 ? "does" : "do"} not appear anywhere on the site`
      : "every word appears in the site's own vocabulary",
  };
}

/**
 * Whether a profile can judge relevance at all.
 *
 * The domain's own tokens are added to every profile, so a profile built from
 * zero fragments is not empty: www.lully.ai's read {"www": 3} after every
 * fetch failed on a TLS error, and the queue ranked "ai can" first because
 * nothing could say it was off-topic. Three terms beyond the domain's own is
 * the floor below which relevance is unknown rather than low.
 */
export function profileIsUsable(profile: TopicalProfile | null | undefined, domain?: string): boolean {
  if (!profile?.terms) return false;
  const own = new Set(domain ? domainTokens(domain) : []);
  own.add("www");
  return Object.keys(profile.terms).filter((t) => !own.has(t)).length >= 3;
}
