// ---------------------------------------------------------------------------
// Playbooks: seed phrases a template can build without a model
// ---------------------------------------------------------------------------
//
// A playbook is a query shape that works for nearly every business - "X
// alternatives", "X vs Y", "best X for Z" - filled in from the profile the
// person confirmed in onboarding. The seeds are deterministic string
// templates on purpose: they are cheap, testable, and the metrics call that
// follows is what decides whether anyone actually searches them.
//
// Nothing here reaches the network. The pipeline takes these seeds to the
// keyword overview endpoint in one batch.

import type { BusinessProfile } from "@/lib/onboarding/business-profile";

export type PlaybookId =
  | "alternatives"
  | "vs"
  | "best_of"
  | "use_case"
  | "integrations"
  | "pricing"
  | "glossary";

export interface Playbook {
  id: PlaybookId;
  title: string;
  description: string;
  /** Which profile field the template draws on; the card says so. */
  needs: "competitors" | "audiences" | "category" | "brand";
  /** The template, shown so nobody has to guess what will be searched. */
  pattern: string;
}

export const PLAYBOOKS: readonly Playbook[] = [
  {
    id: "alternatives",
    title: "Alternatives",
    description: "Capture buyers searching for alternatives to your competitors",
    needs: "competitors",
    pattern: "<competitor> alternatives",
  },
  {
    id: "vs",
    title: "Vs / Comparison",
    description: "Own the head-to-head searches between you and each competitor, and between competitors",
    needs: "competitors",
    pattern: "<you> vs <competitor>",
  },
  {
    id: "best_of",
    title: "Best-of listicles",
    description: "Rank the roundup query each audience types before shortlisting",
    needs: "audiences",
    pattern: "best <category> for <audience>",
  },
  {
    id: "use_case",
    title: "Use-case / Persona",
    description: "One page per audience, on the query that names them",
    needs: "audiences",
    pattern: "<category> for <audience>",
  },
  {
    id: "integrations",
    title: "Integrations",
    description: "Catch people looking for you alongside a tool they already use",
    needs: "brand",
    pattern: "<you> <tool> integration",
  },
  {
    id: "pricing",
    title: "Cost & Pricing",
    description: "Answer the price question for your category and for each competitor",
    needs: "competitors",
    pattern: "<competitor> pricing",
  },
  {
    id: "glossary",
    title: "Glossary / What is",
    description: "Define the terms your market searches before it knows your name",
    needs: "category",
    pattern: "what is <term>",
  },
];

/**
 * The publishing platforms and tools this product connects to. Kept as plain
 * names because that is how people search: "shopify integration", not the
 * integration id. Mirrors the `integrations` reference table (002, 040).
 */
export const INTEGRATION_NAMES: readonly string[] = [
  "WordPress",
  "Shopify",
  "Magento",
  "Webflow",
  "Ghost",
  "Framer",
  "Notion",
  "Wix",
  "Google Analytics",
  "Search Console",
  "Ahrefs",
  "Slack",
  "Zapier",
];

/** A domain as a person would say it: "cal.com" stays, "www.x.co" loses the www. */
export function brandFromDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

/**
 * The bare name of a competitor, for phrases like "<x> alternatives".
 *
 * Searchers write "notion alternatives", not "notion.so alternatives", so the
 * TLD goes. It stays for a domain whose name IS the TLD joke - "cal.com" -
 * because "cal alternatives" is a different query about something else.
 */
export function competitorName(domain: string): string {
  const host = brandFromDomain(domain);
  const parts = host.split(".");
  if (parts.length < 2) return host;
  const name = parts.slice(0, -1).join(".");
  // Three letters or fewer reads as an abbreviation without its suffix.
  return name.length <= 3 ? host : name;
}

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "by", "at", "from",
  "is", "are", "was", "be", "that", "this", "it", "its", "as", "we", "our", "your", "you",
  "they", "their", "who", "how", "what", "into", "than", "more", "most", "all", "any", "can",
  "help", "helps", "helping", "make", "makes", "get", "gets", "use", "using", "used", "one",
  "every", "each", "new", "best", "top", "fast", "easy", "simple", "great", "better", "without",
  "team", "teams", "business", "businesses", "company", "companies", "customers", "customer",
  "users", "user", "people", "way", "ways", "time", "need", "needs", "built", "build", "work",
  "works", "based", "across", "over", "out", "up", "not", "no", "so", "also", "both", "own",
]);

/**
 * The nouns a profile description keeps coming back to: the market's own
 * vocabulary, which is what "what is <term>" should define.
 *
 * Counts single words and adjacent pairs, keeps pairs when both halves are
 * content words, and prefers a pair over its parts so "keyword research"
 * beats "keyword" and "research" separately. Crude by design: the metrics
 * call decides which of these anyone searches.
 */
/**
 * Every spelling of a rival worth matching a phrase against.
 *
 * `competitorName` answers a different question - what to put in front of
 * "alternatives" - and its rule that a name of three letters or fewer keeps
 * its TLD ("cal.com", not "cal") is right for composing a seed and wrong for
 * filtering: it made `wix` unmatchable against wix.com, and qasimcode.com
 * stored `wix` four times over. The suffix trim is the same story from the
 * other end: `acuity` never matched `acuityscheduling`.
 */
const PRODUCT_SUFFIX = /(scheduling|software|app|apps|hq|labs|io|online|digital|studio|group|agency|media|tech)$/;

export function brandAliases(domain: string): string[] {
  const host = brandFromDomain(domain);
  const label = host.split(".").slice(0, -1).join(".") || host;
  const head = label.replace(PRODUCT_SUFFIX, "");
  // Three characters is the floor: below it a "name" matches half the
  // language ("ai", "co"), and no brand is worth that many false drops.
  return [...new Set([host, label, head])].filter((n) => n.length >= 3);
}

/**
 * Reject pure brand navigation. Other mentions need a buyer/format judgement.
 */
export function isBrandTerm(term: string, domain: string, competitors: readonly string[]): boolean {
  const t = ` ${term.toLowerCase().trim()} `;
  const names = [domain, ...competitors]
    .flatMap((d) => brandAliases(d))
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  // A brand mention is not navigation when the search evaluates a purchase.
  const evaluative = /\b(alternatives?|vs|versus|compar\w*|pricing|prices?|costs?|reviews?|integration\w*|migration|migrate|prezz\w*|costo|confront\w*|alternative\w*|avis|prix|kosten|vergleich\w*)\b/iu;
  if (evaluative.test(t)) return false;
  const tokens = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/);
  const query = tokens(t);
  return names.some((name) => {
    const alias = tokens(name);
    return query.some((_, i) => {
      if (!alias.every((word, j) => query[i + j] === word)) return false;
      const remaining = [...query.slice(0, i), ...query.slice(i + alias.length)];
      return remaining.every((word) => /^(login|log|in|signin|sign|support|help|homepage|website|official|account|dashboard|contact|accedi|accesso|assistenza|connexion|anmelden)$/.test(word));
    });
  });
}

export function keyNouns(text: string, limit = 6): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  if (!words.length) return [];

  const pairs = new Map<string, number>();
  // Where each phrase first appears. A one-paragraph description mentions
  // almost every pair exactly once, so frequency ties for all of them and the
  // tie-break decides the answer. Alphabetical order made "agreed upfront" the
  // category of a business whose first clause reads "builds appointment-based
  // websites for clinics" - and the playbooks then asked for "agreed upfront
  // for medical and dental clinics". Position is the signal: a description
  // says what the business does before it says how it is priced.
  const firstAt = new Map<string, number>();
  const singles = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    singles.set(words[i], (singles.get(words[i]) ?? 0) + 1);
  }
  // Pairs must be adjacent in the original text, not merely both present.
  const tokens = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a.length > 2 && b.length > 2 && !STOP.has(a) && !STOP.has(b) && !/^\d+$/.test(a) && !/^\d+$/.test(b)) {
      const key = `${a} ${b}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
      if (!firstAt.has(key)) firstAt.set(key, i);
    }
  }

  const out: string[] = [];
  const covered = new Set<string>();
  const earliest = (k: string) => firstAt.get(k) ?? Number.MAX_SAFE_INTEGER;
  for (const [pair, n] of [...pairs.entries()].sort(
    (x, y) => y[1] - x[1] || earliest(x[0]) - earliest(y[0]) || x[0].localeCompare(y[0]),
  )) {
    if (n < 1) break;
    if (out.length >= limit) break;
    out.push(pair);
    for (const w of pair.split(" ")) covered.add(w);
  }
  const firstWordAt = new Map<string, number>();
  words.forEach((w, i) => { if (!firstWordAt.has(w)) firstWordAt.set(w, i); });
  const earliestWord = (k: string) => firstWordAt.get(k) ?? Number.MAX_SAFE_INTEGER;
  for (const [word] of [...singles.entries()].sort(
    (x, y) => y[1] - x[1] || earliestWord(x[0]) - earliestWord(y[0]) || x[0].localeCompare(y[0]),
  )) {
    if (out.length >= limit) break;
    if (covered.has(word)) continue;
    out.push(word);
  }
  return out.slice(0, limit);
}

/**
 * Words that open a description's main clause without naming its subject.
 * "Qasimcode builds appointment-based websites" - the category is the third
 * and fourth words, and a pair starting with the verb ("builds
 * appointment-based") reads as nonsense inside "<category> for <audience>".
 */
const LEADING_VERBS = new Set([
  "builds", "build", "building", "makes", "make", "making", "creates", "create", "creating",
  "provides", "provide", "providing", "offers", "offer", "offering", "delivers", "deliver",
  "delivering", "designs", "design", "designing", "sells", "sell", "selling", "helps", "help",
  "helping", "gives", "give", "runs", "run", "running", "powers", "power", "powering",
  "is", "are", "was", "were", "specialises", "specializes", "specialising", "specializing",
]);

/**
 * The category a business belongs to, from its profile, in a few words.
 *
 * `brand` is dropped when known: the description almost always opens with the
 * company's own name, and "<brand> builds" is neither a category nor something
 * anybody searches for. It fed the playbooks "qasimcode builds for medical and
 * dental clinics".
 */
export function categoryOf(
  profile: Pick<BusinessProfile, "description">,
  brand?: string | null,
): string | null {
  return categoryCandidates(profile, brand)[0] ?? null;
}

/**
 * Every phrase the description offers as the category, best guess first.
 *
 * One guess was the problem. packhub.io's description opens "PackHub is a
 * scan-driven packout solution for fulfillment teams", so the category
 * became "scan-driven packout" - the company's own coinage, which nobody has
 * ever typed into a search box. Every playbook seed built on it ("scan-driven
 * packout for 3pl providers", "what is scan-driven packout") priced at zero,
 * the profile bought nothing, and the ads fallback filled the pool with
 * Microsoft Teams. qasimcode.com's "appointment-based websites" was the same
 * shape.
 *
 * The order is the description's own - pairs where the business says what it
 * does, then single nouns - and is deliberately NOT second-guessed here: an
 * earlier version demoted hyphenated pairs as likely coinages and promoted
 * "clinics salons" over "appointment-based websites", which is worse. Which
 * of these the market actually uses is a question only search volume answers,
 * and that is `pickCategory`'s job.
 */
export function categoryCandidates(
  profile: Pick<BusinessProfile, "description">,
  brand?: string | null,
  limit = 8,
): string[] {
  const brandTokens = new Set(
    (brand ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2),
  );
  const usable = (n: string) => {
    const [first, ...rest] = n.split(" ");
    if (brandTokens.has(first) || rest.some((w) => brandTokens.has(w))) return false;
    return !LEADING_VERBS.has(first);
  };
  const nouns = keyNouns(profile.description, limit).filter(usable);
  const pairs = nouns.filter((n) => n.includes(" "));
  const singles = nouns.filter((n) => !n.includes(" "));
  return [...pairs, ...singles].slice(0, limit);
}

/**
 * The candidate the market searches for, given what a provider said about
 * each. Highest volume wins; the description's own order breaks ties; a list
 * nobody priced falls back to the first guess, which is what `categoryOf`
 * always returned.
 */
export function pickCategory(
  candidates: readonly string[],
  metrics: ReadonlyMap<string, { volume: number | null }>,
  minVolume = 50,
): string | null {
  let best: { term: string; volume: number } | null = null;
  for (const term of candidates) {
    const v = metrics.get(term.toLowerCase())?.volume ?? null;
    if (v === null || v < minVolume) continue;
    if (!best || v > best.volume) best = { term, volume: v };
  }
  return best?.term ?? candidates[0] ?? null;
}

export interface SeedContext {
  /** The business's own name, for "<you> vs" and integrations. */
  brand: string;
  profile: Pick<BusinessProfile, "description" | "audiences" | "competitors">;
  /** Overrides the description-derived category when the person supplies one. */
  category?: string | null;
}

/** Lower-case, single-spaced, trimmed - and de-duplicated by the caller. */
function clean(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique(seeds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of seeds) {
    const s = clean(raw);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * The seed phrases one playbook produces for one business.
 *
 * Returns [] when the profile lacks what the playbook needs - no competitors
 * for Alternatives, no audiences for Best-of - so the UI can say why rather
 * than research an empty template.
 */
export function buildPlaybookSeeds(id: PlaybookId, ctx: SeedContext): string[] {
  const competitors = ctx.profile.competitors.map(competitorName).filter(Boolean);
  const audiences = ctx.profile.audiences.map(clean).filter(Boolean);
  const category = ctx.category ?? categoryOf(ctx.profile, ctx.brand);
  const brand = clean(ctx.brand);

  switch (id) {
    case "alternatives":
      return unique(competitors.flatMap((c) => [`${c} alternatives`, `${c} alternative`]));
    case "vs": {
      const own = brand ? competitors.map((c) => `${brand} vs ${c}`) : [];
      const pairs: string[] = [];
      for (let i = 0; i < competitors.length; i++) {
        for (let j = i + 1; j < competitors.length; j++) {
          pairs.push(`${competitors[i]} vs ${competitors[j]}`);
        }
      }
      return unique([...own, ...pairs]);
    }
    case "best_of":
      if (!category) return [];
      return unique(audiences.map((a) => `best ${category} for ${a}`));
    case "use_case":
      if (!category) return [];
      return unique(audiences.map((a) => `${category} for ${a}`));
    case "integrations":
      if (!brand) return [];
      return unique(INTEGRATION_NAMES.map((t) => `${brand} ${t} integration`));
    case "pricing": {
      const per = competitors.map((c) => `${c} pricing`);
      const cat = category ? [`how much does ${category} cost`, `${category} pricing`] : [];
      return unique([...per, ...cat]);
    }
    case "glossary":
      return unique(keyNouns(ctx.profile.description, 8).map((n) => `what is ${n}`));
  }
}

// ---------------------------------------------------------------------------
// Audience seeds for the automatic first look
// ---------------------------------------------------------------------------
//
// #180 established the principle: the automatic path had never used the
// audiences, so qasimcode.com's twenty keywords all came from n-grams of its
// blog tag pages and not one contained "book", "appoint", "clinic", "salon",
// "dental", "therap", "trade", "calendar" or "schedul".
//
// This is the seed SHAPE, which #180 left as the drawer's playbook templates
// and which does not survive contact with the endpoint. Two measured problems:
//
//   too long   `keyword_suggestions` returns only phrases CONTAINING the seed.
//              "appointment-based websites for medical and dental clinics" is
//              seven words; nothing contains it. "dental clinic website" is
//              three, and "dental clinic website design" contains it.
//   never bought   `discoverKeywordsFromSeeds` slices to `maxSeeds` (5), and
//                  #180 concatenates [...headingSeeds, ...profileSeeds]. The
//                  heading seeder returns up to 8, so on any site with readable
//                  headings the audience seeds fall off the end of the slice and
//                  are never bought at all. `mergeSeeds` in domain-analysis.ts
//                  reserves slots for them instead.
//
// The long tail this business can win is "dental clinic website" and "salon
// appointment website" - three and four words, a named buyer at the end of
// them. "website design" (49,500/mo, KD 70) is what the headings produced.

/** A seed and the audience it came from, so the row can carry its provenance. */
export interface AudienceSeed {
  seed: string;
  audience: string;
}

/**
 * The head of an audience phrase: the last two content words, singularised.
 *
 * "Medical and dental clinics" -> "dental clinic", "Small businesses needing
 * appointment booking" -> "appointment booking". Two words rather than the
 * whole phrase because `keyword_suggestions` only returns phrases containing
 * the seed, and a six-word seed returns nothing.
 */
export function audienceHead(audience: string): string {
  const words = audience
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  return words
    .slice(-2)
    .map((w) => (w.endsWith("ies") && w.length > 4 ? `${w.slice(0, -3)}y` : w.endsWith("s") && !w.endsWith("ss") && w.length > 3 ? w.slice(0, -1) : w))
    .join(" ");
}

/**
 * The one noun that names what the business sells: "website" for a studio that
 * builds websites, so an audience becomes "dental clinic website".
 *
 * Taken from the crawled profile rather than the description, because the
 * profile is already weighted - `SIGNATURE_BOOST` puts the homepage headline's
 * words at the top - and because `categoryOf` reads the description by
 * counting adjacent word pairs, all of which occur exactly once in three
 * sentences, so it falls back to an alphabetical tie-break and returns "agreed
 * upfront". Every audience playbook for qasimcode.com therefore reads "best
 * agreed upfront for medical and dental clinics".
 *
 * Three conditions, in order of how much each removes:
 *
 *   in the description   the profile's top terms include the brand and the
 *                        audiences; what the business SAYS it makes is in its
 *                        own description of itself
 *   not the brand        "qasimcode" is the strongest term in every profile
 *   not an audience word "studios", "clinics" and "salons" are who they sell
 *                        to, not what they sell, and they outrank "websites"
 *
 * Null when nothing survives, which turns audience seeding off rather than
 * guessing.
 */
export interface SubjectFields {
  description?: string | null;
  audiences?: string[] | null;
}

export function categoryHead(
  business: SubjectFields,
  profile: { topTerms?: string[] | null } | null | undefined,
  domain?: string,
): string | null {
  const top = profile?.topTerms ?? [];
  if (!top.length || !business.description) return null;
  const inDescription = new Set(
    business.description.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
  );
  const audienceWords = new Set(
    (business.audiences ?? [])
      .join(" ")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  const brand = new Set(
    (domain ?? "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  const singular = (w: string) =>
    w.endsWith("ies") && w.length > 4
      ? `${w.slice(0, -3)}y`
      : w.endsWith("s") && !w.endsWith("ss") && w.length > 3
        ? w.slice(0, -1)
        : w;

  for (const term of top) {
    if (term.length < 4) continue;
    if (brand.has(term) || STOP.has(term)) continue;
    if (audienceWords.has(term) || audienceWords.has(singular(term))) continue;
    if (!inDescription.has(term) && !inDescription.has(singular(term))) continue;
    return singular(term);
  }
  return null;
}

/**
 * One seed per audience: "<audience> <what we sell>".
 *
 * Returns [] with no audiences or no category head, which leaves the page
 * seeds in sole possession of the budget - exactly today's behaviour.
 */
export function audienceSeeds(
  business: SubjectFields | null | undefined,
  profile: { topTerms?: string[] | null } | null | undefined,
  domain?: string,
  /**
   * The category to build on, when the caller has one the market actually
   * searches (`resolveCategory`). Without it the head is the profile's top
   * term that also appears in the description - which for packhub.io was
   * "pack", from a tagline that repeats it, so every audience seed read
   * "shopify fulfillment pack".
   */
  head?: string | null,
): AudienceSeed[] {
  if (!business?.audiences?.length) return [];
  const chosen = head?.trim().toLowerCase() || categoryHead(business, profile, domain);
  if (!chosen) return [];
  return audienceSeedsFor(business, chosen);
}

function audienceSeedsFor(business: SubjectFields, head: string): AudienceSeed[] {
  const seen = new Set<string>();
  const out: AudienceSeed[] = [];
  for (const audience of business.audiences ?? []) {
    const a = audienceHead(audience);
    if (!a || a.includes(head) || seen.has(a)) continue;
    seen.add(a);
    out.push({ seed: `${a} ${head}`, audience });
  }
  return out;
}

/** The example line a playbook card shows, from the person's own profile. */
export function playbookExamples(id: PlaybookId, ctx: SeedContext, limit = 3): string[] {
  return buildPlaybookSeeds(id, ctx).slice(0, limit);
}
