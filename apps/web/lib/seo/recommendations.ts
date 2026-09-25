import { readOpportunity, contextKey, duplicateVerdict, OPPORTUNITY_VERSION, type Opportunity } from "@/lib/keyword-research/opportunity";
import { clusterByIntent, intentKey, sameIntent, storedSerp, unfoldedNote, type IntentFollower, type IntentStage, type StagedTopic } from "@/lib/keyword-research/intent";
import { articleStage, leadersFrom, type IntentLeader } from "@/lib/keyword-research/intent-leaders";
import { ensureBusinessProfile } from "@/lib/keyword-research/business-context";
import { causeLabel } from "@/lib/keyword-research/opportunity";
import { funnelOf, type FitVerdict, type Funnel } from "@/lib/keyword-research/buyer-fit";
import { isParked, isParkedForGood, isRequalifiable, parkKeywords, queueTarget, refillQualifiedQueue, type QueueRow } from "@/lib/keyword-research/queue";
import { languageCodeOf } from "@/lib/keyword-research/locale";
// ---------------------------------------------------------------------------
// What to write next
// ---------------------------------------------------------------------------
//
// Turns tracked keywords into a ranked, explainable queue. This is the input to
// autonomous generation: without it, "generate an article automatically" has no
// principled way to choose a keyword and would just take whatever sorts first.
//
// Deterministic and free. Every score is arithmetic over data already in the
// database, so the same inputs always produce the same queue, a human can audit
// why a keyword was chosen, and picking the next topic costs nothing. A model
// call here would be non-reproducible and would make the ordering unexplainable
// at exactly the moment a human wants to know "why is it writing about this?".
//
// Scoring is opportunity x winnability:
//
//   opportunity   how much traffic is realistically on the table, from search
//                 volume plus impressions the site already earns for the term
//   winnability   how likely we are to actually get it, from difficulty and
//                 from how close the site already ranks
//
// The largest multiplier is striking distance. A keyword sitting at position
// 11-20 is one good revision from page one, which is far cheaper than earning a
// new ranking from nothing, and it is the single most reliable SEO win there is.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { KeywordIntent } from "@/lib/types";
import { scoreRelevance, subjectVocabulary, type TopicalProfile } from "./topical-profile";
import { commercialFit } from "./commercial-fit";
import { relativeDifficulty, isOutOfReach } from "./difficulty";

export type RecommendedAction = "write" | "refresh" | "skip";

/**
 * `suspect` means the term looks like provider noise rather than something a
 * person typed into Google.
 *
 * Keyword APIs return a lot of this: "s eo", "zap ier", "_zapier", "all & one".
 * They carry real-looking volume and difficulty, so they score well and float
 * to the top of the queue. A human scanning the keywords page discards them in
 * a glance. An unattended generator does not, and publishing an article titled
 * "S Eo: A Complete Guide" is materially worse than publishing nothing.
 *
 * Suspect terms are still returned and still visible, because the judgement is
 * heuristic and a human may disagree. They are only withheld from the
 * autonomous path, where nobody is watching.
 */
export type KeywordQuality = "ok" | "suspect";

export interface KeywordRecommendation {
  keywordId: string;
  term: string;
  /** Null when nobody measured it (a keyword typed in by hand). */
  volume: number | null;
  difficulty: number | null;
  intent: KeywordIntent;
  /** Composite score; only meaningful relative to the other rows. */
  score: number;
  action: RecommendedAction;
  /** Plain-language reasons, in the order they influenced the score. */
  reasons: string[];
  /** Set when an article in this workspace already targets the term. */
  existingArticleId: string | null;
  /** A page on the site, not written here, that already targets the term. */
  existingPageUrl: string | null;
  /** Most recent tracked position, when the rank cron has run. */
  currentPosition: number | null;
  /** Impressions over the GSC lookback window, when Search Console is synced. */
  impressions: number | null;
  quality: KeywordQuality;
  /** Why it was flagged; null when quality is `ok`. */
  qualityNote: string | null;
  opportunity?: Opportunity;
  /** "audience" for a top-of-funnel topic; null when no buyer verdict is saved. */
  funnel: Funnel | null;
}

/**
 * Spot keyword-provider noise.
 *
 * `allTerms` is the rest of the tracked set, used to catch split-word variants:
 * "s eo" is junk precisely because "seo" is also tracked, and "zap ier" because
 * "zapier" is. That comparison is what separates a genuine short multi-word
 * query from a mangled single word.
 */
/** One-letter tokens that are words in the product's markets: en "a"/"i", it/es/pt "e"/"o"/"y"/"a", fr "à"/"y", it "è". */
const ONE_LETTER_WORDS = new Set(["a", "i", "e", "o", "y", "à", "è", "é", "ù"]);

export function assessKeywordQuality(
  term: string,
  allTerms: Set<string>,
): { quality: KeywordQuality; note: string | null } {
  const clean = term.trim().toLowerCase();

  if (clean.length < 3) {
    return { quality: "suspect", note: "too short to be a real query" };
  }

  // Anything outside letters, numbers, spaces, hyphens and apostrophes is a
  // provider artifact rather than something typed into a search box.
  if (/[^\p{L}\p{N}\s'-]/u.test(clean)) {
    return { quality: "suspect", note: "contains characters a searcher would not type" };
  }

  const tokens = clean.split(/\s+/).filter(Boolean);

  // "s eo", "zap ier": a lone letter is a split word - unless it is a word.
  // "how to start a paid newsletter" was refused on 2026-09-07 because of
  // the "a"; the articles and one-letter words of the markets the product
  // is sold into are real tokens, not fragments.
  if (tokens.some((t) => t.length === 1 && !ONE_LETTER_WORDS.has(t))) {
    return { quality: "suspect", note: "contains a single-letter word, likely a split word" };
  }

  // "s eo" -> "seo", "zap ier" -> "zapier": if gluing the tokens together
  // produces another keyword we track, this is a typo variant of that one.
  if (tokens.length > 1) {
    const glued = tokens.join("");
    if (allTerms.has(glued)) {
      return { quality: "suspect", note: `looks like a split spelling of "${glued}"` };
    }
  }

  // A trailing two-letter fragment after a real word is usually truncation
  // ("seo co" for "seo company"), which reads as a typo in a title.
  if (tokens.length > 1 && tokens[tokens.length - 1].length === 2) {
    return { quality: "suspect", note: "ends in a two-letter fragment, likely truncated" };
  }

  // The first unattended run on altorank.co (2026-09-02) wrote an article for
  // "no keywords", 27,100 searches a month, difficulty 0, "on-topic" because
  // the site says "keywords" everywhere. The term is a fragment of a question
  // nobody wants an article about. Two shapes catch that whole family:
  //
  //   a leading negation or function word    "no keywords", "not seo", "and seo"
  //   a repeated token                        "seo and seo", "seo what is seo"
  //
  // Both are provider artifacts of keywords_for_site, which returns phrase
  // fragments with their aggregate volume attached.
  const LEADING_JUNK = new Set(["no", "not", "and", "or", "the", "a", "an", "of", "to", "in", "is", "vs"]);
  if (tokens.length > 1 && LEADING_JUNK.has(tokens[0])) {
    return { quality: "suspect", note: `starts with "${tokens[0]}", a fragment rather than a query` };
  }
  if (tokens.length > 1 && new Set(tokens).size < tokens.length) {
    return { quality: "suspect", note: "repeats a word, a provider fragment rather than a query" };
  }
  // "worlder inc", "acme ltd", "soluzioni srl": a company name from a
  // competitor's ranked keywords. It has volume because people search the
  // brand, and an article titled "Worlder Inc: A Complete Guide" on someone
  // else's site is the wrong thing to write. Planned on the first live
  // onboarding run (2026-09-04), which is how this rule got here.
  const COMPANY_SUFFIX = new Set(["inc", "ltd", "llc", "gmbh", "srl", "sas", "corp", "plc", "ag", "bv", "oy", "pty", "sa", "spa", "kg"]);
  if (tokens.length > 1 && COMPANY_SUFFIX.has(tokens[tokens.length - 1].replace(/\.$/, ""))) {
    return { quality: "suspect", note: "names a company rather than a topic" };
  }

  // "ai can", "ai in": the query was cut mid-phrase. Nobody searches that.
  const TRAILING_JUNK = new Set(["can", "in", "for", "and", "the", "of", "to", "is", "with", "on", "by", "or", "start", "started", "add", "adding"]);
  if (tokens.length > 1 && TRAILING_JUNK.has(tokens[tokens.length - 1])) {
    return { quality: "suspect", note: `ends with "${tokens[tokens.length - 1]}", a fragment rather than a query` };
  }
  // "ai in company", "ai in world", "ai for business": a preposition and a
  // bare generic noun. The Ads endpoint emits these as phrase fragments with
  // the aggregate volume of everything they abbreviate.
  // "reviews and seo", "content and seo", "ai and logistics": two nouns
  // joined by "and" is how the Ads endpoint labels a topic pair, and nobody
  // types it. altorank.co's own queue led with "reviews and seo" (480/mo).
  if (tokens.length === 3 && (tokens[1] === "and" || tokens[1] === "or")) {
    return { quality: "suspect", note: `two words joined by "${tokens[1]}", a topic label rather than a query` };
  }
  // A word that carries no topic. Any keyword containing one is a fragment
  // of a sentence the provider chopped up, not something a person typed:
  // supalabs.co's list arrived as "ai stop", "ai makes", "ai are you",
  // "not ai", "its ai", "ai more", "all the answers are correct"
  // (2026-09-02). Question words and comparatives are deliberately absent:
  // "what is logistics" and "best warehouse software" are real queries.
  const FRAGMENT_WORDS = new Set([
    // "start"/"started"/"add"/"adding" were here and refused "how to start
    // a paid newsletter" and "how to add a signup form" - the commonest
    // how-to shapes. The fragments they caught ("ai started") end on the
    // word, which TRAILING_JUNK is the place for.
    "stop", "makes", "make", "made", "making",
    "are", "you", "your", "we", "our", "us", "its", "it", "this", "that",
    "than", "then", "being", "been", "correct", "answers", "answer",
    "differently", "operating", "keep", "more", "less", "not", "into",
    "through", "between", "started", "most",
  ]);
  if (tokens.some((t) => FRAGMENT_WORDS.has(t))) {
    return { quality: "suspect", note: "contains a word that carries no topic; a sentence fragment rather than a query" };
  }

  const PREPOSITION = new Set(["in", "for", "of", "on", "at", "to"]);
  const GENERIC_TAIL = new Set(["company", "companies", "business", "businesses", "world", "work", "real", "level", "levels", "things", "life", "people"]);
  if (tokens.length === 3 && PREPOSITION.has(tokens[1]) && GENERIC_TAIL.has(tokens[2])) {
    return { quality: "suspect", note: `"${tokens[1]} ${tokens[2]}" is a phrase fragment, not a query` };
  }

  return { quality: "ok", note: null };
}

const GSC_LOOKBACK_DAYS = 90;

/** "/alternatives/rankingcoach/" for a full URL; the URL itself when it will not parse. */
function pathOf(url: string): string {
  try { return new URL(url).pathname || "/"; } catch { return url; }
}

/**
 * Relevance scales the score between this floor and 1, rather than to zero.
 *
 * A keyword whose words never appear on the site keeps 25% of its score instead
 * of vanishing. The profile is built from up to 40 crawled pages, so a business
 * expanding into something it has not written about yet would otherwise have
 * that opportunity permanently suppressed. Demoted, visible, and overridable by
 * a human is the right strength for a heuristic this crude.
 */
const RELEVANCE_FLOOR = 0.25;

/** Position bands where a revision is worth more than a new article. */
const STRIKING_MIN = 11;
const STRIKING_MAX = 20;
/** Already winning: leave it alone rather than competing with ourselves. */
const ALREADY_WON = 10;
/**
 * How far past the striking band a *measured* term still counts as one.
 *
 * The 11-20 band was set for positions bought from a SERP snapshot. Search
 * Console reports a different kind of position: an impression-weighted mean
 * over the site's real audience, and it comes with the impressions that
 * prove people saw the listing. A term Google has shown a site 171 times at
 * position 29 is stronger evidence than a 9,900/mo volume estimate for a
 * term the site has never appeared for - and until 2026-09-17 the scorer
 * ranked them the other way round (altorank.co: "site rank" above
 * "ranking coach alternative"; validate:picks 1/5). Measured demand extends
 * the band; a bare position from a SERP snapshot still does not.
 */
const STRIKING_MEASURED_MAX = 40;
const STRIKING_MEASURED_MIN_IMPRESSIONS = 50;

export type PositionBand = "won" | "striking" | "ranking";

/** Which band a position falls in, given how much demand was measured behind it. */
export function positionBand(position: number | null, impressions: number | null): PositionBand | null {
  if (position === null) return null;
  if (position <= ALREADY_WON) return "won";
  if (position >= STRIKING_MIN && position <= STRIKING_MAX) return "striking";
  if (
    position > STRIKING_MAX &&
    position <= STRIKING_MEASURED_MAX &&
    (impressions ?? 0) >= STRIKING_MEASURED_MIN_IMPRESSIONS
  )
    return "striking";
  return "ranking";
}

/**
 * Volume contributes on a log scale.
 *
 * A 200,000/mo head term is not a hundred times better than a 2,000/mo one: it
 * is far harder, usually broader in intent, and the realistic click share is a
 * fraction of the volume. Linear volume makes the queue nothing but head terms,
 * which is the classic way to spend a year ranking for nothing.
 */
/** An audience topic against the same search made with buying intent. */
export const AUDIENCE_TOPIC_WEIGHT = 0.5;

/** What an unmeasured volume scores: the same as ~30 searches a month. */
const UNKNOWN_VOLUME_SCORE = 15;

function volumeScore(volume: number): number {
  if (volume <= 0) return 0;
  return Math.log10(volume + 1) * 10;
}

/**
 * Difficulty as a 0-1 multiplier.
 *
 * Unknown difficulty resolves to 0.6 rather than 1.0. Treating "we do not know"
 * as "easy" would float every unmeasured keyword to the top, which is the same
 * failure as rendering a null difficulty as a green zero.
 */
/**
 * What an out-of-reach keyword keeps, rather than zero.
 *
 * `relativeDifficulty` saturates: at authority 0 every KD from 45 to 100 maps
 * to relative 100, so `1 - relative/100` was exactly 0 and multiplied the
 * whole score away. Twelve of qasimcode.com's twenty keywords scored 0.0 and
 * were therefore in arbitrary order - insertion order, since the sort is
 * stable - so the plan picked among KD 56, KD 86 and KD 100 by whichever row
 * the provider had returned first. Order has to survive even when the answer
 * is "none of these".
 */
const UNWINNABLE_FLOOR = 0.02;

function winnability(difficulty: number | null, volume = 0, authority?: number | null): number {
  if (difficulty === null) return 0.6;
  // Judged against this site when we know its authority. KD is absolute - it
  // describes the SERP, not the contender - so KD 40 is a rounding error at
  // DR 80 and unreachable at DR 0.2, and ranking both the same way is how a
  // new site gets a content plan it cannot execute. Both numbers are fetched
  // in the same analyseDomain run and were never compared.
  if (typeof authority === "number" && Number.isFinite(authority)) {
    const { relative } = relativeDifficulty(difficulty, authority);
    if (relative !== null) {
      if (difficulty === 0 && volume >= 1000) return 0.6;
      return Math.max(UNWINNABLE_FLOOR, 1 - relative / 100);
    }
  }
  // Difficulty 0 on a term with real volume is the provider saying "not
  // computed", not "free". Treated as easy it multiplies by 1.0 and floats a
  // fragment like "no keywords" (27,100/mo, KD 0) to the top of the queue.
  if (difficulty === 0 && volume >= 1000) return 0.6;
  const d = Math.min(Math.max(difficulty, 0), 100);
  return 1 - d / 100;
}

/**
 * Commercial and transactional terms are worth marginally more to an account's
 * client than informational ones, because they sit closer to a sale. Kept small
 * deliberately: intent is a tiebreak, not a thesis, and the classifier is a
 * lexicon rather than an oracle.
 */
// Retuned 2026-09-02 after the first outside workspace (www.lully.ai) queued
// "ai system" (9,900/mo, informational) above "warehouse management system"
// (14,800/mo, commercial) and "ai orchestration" (their own product term).
// Intent is no longer a tiebreak: a term closer to a sale is worth half again
// as much as a definition query, and a navigational term (someone looking
// for a specific other site) is worth very little.
const INTENT_WEIGHT: Record<KeywordIntent, number> = {
  transactional: 1.5,
  commercial: 1.5,
  navigational: 0.3,
  info: 1.0,
};

/**
 * A one-word head term ("warehouse", "logistics", "ai") is a category, not
 * an article. It carries huge volume, near-impossible difficulty, and no
 * angle to write from; it should sit below any specific phrase that fits.
 */
const SINGLE_WORD_PENALTY = 0.5;

/**
 * How much a keyword that names an audience the customer confirmed is worth
 * over one that merely uses the site's vocabulary.
 *
 * Relevance cannot separate these two. Measured on qasimcode.com, a studio
 * selling booking websites to clinics and salons: "website design service"
 * (6,600/mo) and "best dental clinic website" (210/mo) both score a flat 1.0,
 * because every word of both appears on the site. Volume then decides, and
 * `volumeScore` is logarithmic - 38.2 against 23.2 - so the generic term wins
 * and the first article we wrote them was "Website Design Service in 2026:
 * Compare Your Options" rather than anything about a dental clinic.
 *
 * The signal that separates them is not in the text: it is that the person
 * told us, in the wizard, who they sell to. `source_type = 'audience'` records
 * exactly that, and nothing was reading it. 1.75 is the smallest multiplier
 * that lets a term naming a confirmed buyer outrank a generic one roughly an
 * order of magnitude larger, which is the trade this product exists to make -
 * a smaller, winnable, on-topic article beats a bigger one about the category.
 */
const AUDIENCE_BOOST = 1.75;

export async function recommendKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
  options?: { limit?: number; qualify?: boolean; qualifyBatches?: number },
): Promise<KeywordRecommendation[]> {
  const limit = options?.limit ?? 25;

  const { data: keywords, error } = await supabase
    .from("keywords")
    .select("id, term, volume, difficulty, intent, status, source, source_type, source_ref, source_url, opportunity, buyer_fit, plan_excluded_at")
    .eq("workspace_id", workspaceId);

  if (error) throw new Error(`Could not read keywords: ${error.message}`);
  if (!keywords?.length) return [];

  // What this business is actually about. Without it, scoring optimises volume
  // and difficulty alone and will happily recommend a keyword from a completely
  // different industry.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("topical_profile, dr, business_profile, domain, language, location_code, auto_generate_weekly_limit")
    .eq("id", workspaceId)
    .single();

  const profile = (workspace?.topical_profile as TopicalProfile | null) ?? null;
  // The wizard's answers, which say what the business sells in words the crawl
  // cannot supply: the competitors it names have no reason to appear in its own
  // headings, and neither do the audiences it has not written a page for yet.
  const business = workspace?.business_profile as {
    name?: string | null;
    offerings?: string[] | null;
    description?: string | null;
    audiences?: string[] | null;
    competitors?: string[] | null;
  } | null;
  const subject = subjectVocabulary(business, profile);
  // Null when never measured, which relativeDifficulty treats as "do not
  // judge" rather than "zero authority".
  const authority = (workspace?.dr as number | null) ?? null;

  const keywordIds = keywords.map((k) => k.id as string);
  const allTerms = new Set(keywords.map((k) => (k.term as string).trim().toLowerCase()));
  // The language the keywords are searched in, for telling two phrasings of
  // one search apart (lib/keyword-research/intent.ts). The column is NOT NULL;
  // a workspace this could not read compares words unfolded and says so,
  // rather than being stemmed as English.
  const language = workspace?.language ? languageCodeOf(workspace.language as string) : null;

  // --- Signals ------------------------------------------------------------
  // Each of these is optional: a workspace with no rank history and no Search
  // Console still gets a usable queue from volume, difficulty and intent alone.

  const [rankRes, articleRes, gscRes, pagesRes] = await Promise.allSettled([
    supabase
      .from("keyword_rankings")
      .select("keyword_id, position, checked_at")
      .in("keyword_id", keywordIds)
      .order("checked_at", { ascending: false }),
    supabase
      .from("articles")
      .select("id, keyword, keyword_id, status")
      .eq("workspace_id", workspaceId)
      .not("keyword", "is", null),
    supabase
      .from("analytics_metrics")
      .select("query, impressions")
      .eq("workspace_id", workspaceId)
      .eq("source", "gsc")
      .gte(
        "metric_date",
        new Date(Date.now() - GSC_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10),
      )
      .not("query", "is", null)
      // Query-only rows. Search Console is also stored as query+page rows
      // (lib/gsc/rows.ts), and reading those here counted every impression
      // twice and, worse, turned "Google once showed the homepage for this"
      // into "a page of yours already targets this" - which skipped exactly
      // the striking-distance rows the scorer multiplies by 2.5 (altorank.co,
      // 2026-09-22). The seeder guards the same way (lib/gsc/seed.ts).
      .is("page_url", null),
    // The site's own pages and the query each one targets (lib/seo/site-crawl.ts
    // fills `keyword` from the heading or from a ranking). An article written
    // for a query one of these pages already holds is a second page on one
    // query: altorank.co drafted "rankingcoach alternative" while
    // /alternatives/rankingcoach/ sat at position 28 for it (2026-09-18).
    supabase
      .from("site_pages")
      .select("url, keyword")
      .eq("workspace_id", workspaceId)
      .not("keyword", "is", null),
  ]);

  // Most recent position per keyword; the query is already newest-first.
  const latestPosition = new Map<string, number>();
  if (rankRes.status === "fulfilled") {
    for (const row of (rankRes.value.data ?? []) as Array<{
      keyword_id: string;
      position: number | null;
    }>) {
      if (row.position === null) continue;
      if (!latestPosition.has(row.keyword_id)) {
        latestPosition.set(row.keyword_id, row.position);
      }
    }
  }

  // Keyed by the words a keyword competes on, so an article about "agency
  // seo" is also found when scoring "agency for seo".
  type ArticleRow = { id: string; keyword: string | null; keyword_id: string | null; status: string | null };
  const articleRows = articleRes.status === "fulfilled" && !articleRes.value.error ? (articleRes.value.data ?? []) as ArticleRow[] : null;
  const articleByTerm = new Map<string, ArticleRow>();
  for (const a of articleRows ?? []) {
    if (a.keyword) articleByTerm.set(intentKey(a.keyword, language), a);
  }

  // The page on this site that targets a query: a crawled page whose keyword
  // is the query (lib/seo/site-crawl.ts). Keyed like `articleByTerm`, so
  // phrasings meet. Not the page Search Console shows for the query: that is
  // where Google happened to land an impression, and for a term at position
  // 34 it is usually the homepage - a page that targets nothing.
  const pageRows = pagesRes.status === "fulfilled" && !pagesRes.value.error ? (pagesRes.value.data ?? []) as Array<{ url: string; keyword: string | null }> : null;
  const pageByTarget = new Map<string, string>();
  for (const p of pageRows ?? []) {
    if (p.keyword && p.url) pageByTarget.set(intentKey(p.keyword, language), p.url);
  }

  const impressionsByTerm = new Map<string, number>();
  if (gscRes.status === "fulfilled") {
    for (const row of (gscRes.value.data ?? []) as Array<{
      query: string | null;
      impressions: number | null;
    }>) {
      if (!row.query) continue;
      const key = row.query.toLowerCase().trim();
      impressionsByTerm.set(key, (impressionsByTerm.get(key) ?? 0) + (row.impressions ?? 0));
    }
  }

  // --- Score --------------------------------------------------------------
  const recommendations: KeywordRecommendation[] = keywords.map((k) => {
    const term = (k.term as string).toLowerCase().trim();
    // Null is "nobody measured this", which is what a keyword typed in by
    // hand carries (app/actions/keywords.ts). It used to read as 0 searches
    // and score 0, so the one keyword the owner asked for by name sat under
    // every provider row and never reached the plan. Scored conservatively,
    // the way an unknown difficulty already is.
    const volumeKnown = typeof k.volume === "number";
    const volume = volumeKnown ? (k.volume as number) : null;
    const difficulty = (k.difficulty as number | null) ?? null;
    const labelled = ((k.intent as KeywordIntent) ?? "info") satisfies KeywordIntent;
    // A provider's "navigational" means "this looks like a name". The buyer
    // test has read the phrase against the business and, when it kept it, said
    // what it is: a product search or an audience question. That verdict is
    // about this site; the label is about the string. fitsuite.co, 2026-09-19:
    // "gestionale palestra" (390/mo, KD 6) was labelled navigational, took the
    // 0.3 weight against 1.5, and lost its own search intent to a 90/mo
    // phrasing of the same query. Brand navigation never gets here: the buyer
    // test refuses it.
    const kept = funnelOf(k.buyer_fit as FitVerdict | null);
    const intent: KeywordIntent = labelled === "navigational" && kept ? (kept === "buyer" ? "commercial" : "info") : labelled;

    const position = latestPosition.get(k.id as string) ?? null;
    const existingArticleId = articleByTerm.get(intentKey(term, language))?.id ?? null;
    const existingPageUrl = pageByTarget.get(intentKey(term, language)) ?? null;
    const impressions = impressionsByTerm.get(term) ?? null;

    const reasons: string[] = [];

    let score = volume === null ? UNKNOWN_VOLUME_SCORE : volumeScore(volume);
    if (volume === null) reasons.push("volume unknown, scored conservatively");
    else if (volume > 0) reasons.push(`${volume.toLocaleString()} searches/mo`);

    // Proven demand on this exact site beats estimated demand anywhere.
    if (impressions && impressions > 0) {
      score += Math.log10(impressions + 1) * 6;
      reasons.push(`${impressions.toLocaleString()} impressions already earned`);
    }

    score *= winnability(difficulty, volume ?? 0, authority);
    reasons.push(
      difficulty === null
        ? "difficulty unknown, scored conservatively"
        : `difficulty ${difficulty}`,
    );

    score *= INTENT_WEIGHT[intent];

    // A search by the people the business sells to, made while they are not
    // shopping. Worth writing, and worth less than a search by someone who is:
    // it sits below every comparable buying topic and says so on the row.
    const funnel = kept;
    if (labelled !== intent) reasons.push(`labelled navigational by the keyword index; the buyer test read it as ${kept === "buyer" ? "a product search" : "an audience question"}`);
    if (funnel === "audience") {
      score *= AUDIENCE_TOPIC_WEIGHT;
      reasons.push("top of funnel: your audience searches this, but not while choosing a product");
    }

    let action: RecommendedAction = "write";

    const band = positionBand(position, impressions);
    if (band === "won") {
      action = "skip";
      score *= 0.15;
      reasons.push(`already ranking at position ${position}, leave it alone`);
    } else if (band === "striking") {
      action = existingArticleId ? "refresh" : "write";
      score *= 2.5;
      reasons.push(
        position! <= STRIKING_MAX
          ? `position ${position} is striking distance, one revision from page one`
          : `position ${position} with ${impressions!.toLocaleString()} impressions: Google already shows this site for it, one good article from page one`,
      );
    } else if (band === "ranking") {
      score *= 1.2;
      reasons.push(`ranking at position ${position}`);
    }

    if (existingArticleId && action === "write") {
      // Writing a second article for a term we already cover splits the ranking
      // between two pages instead of concentrating it on one.
      action = "refresh";
      score *= 0.8;
      reasons.push("an article already targets this, refresh rather than duplicate");
    } else if (existingPageUrl && !existingArticleId && (action === "write" || action === "refresh")) {
      // A page this product did not write and cannot revise. The honest
      // answer is the page, not a competing post: say which one.
      action = "skip";
      reasons.push(`your page ${pathOf(existingPageUrl)} already targets this; update that page rather than add a second one`);
    }

    // --- Relevance ---------------------------------------------------------
    // The third axis. A keyword can be high-volume and easy to win and still be
    // worthless because the business has nothing to say about it.
    // A term the site already ranks for is not subject to this at all. The
    // storage path says why - "the SERP already decided" - and then this
    // re-scored it anyway, because the row carried no provenance. cal.com
    // ranks 10-15 for "google calendar", 3.35M searches a month, and
    // scoreRelevance scores it 0: "google" is not in cal.com's own headings.
    // The filter is for terms nobody has tested. A ranking is a test result.
    //
    // Provenance alone was the wrong test. `source` is NULL for every keyword
    // in the hosted database - all 443 of them - so this was never true and the
    // bypass the comment above describes has never once fired in production.
    // Meanwhile supalabs.co ranks at 45, 46 and 69 for terms scored as
    // untested, and was told "openai", "api" and "calculator" do not appear
    // anywhere on the site. They do not. It ranks anyway.
    //
    // An observed position is the test result this is asking for, and it is
    // already in scope. Where the row came from is bookkeeping; whether Google
    // put the site on the page is evidence.
    // What "proven" was in code until 2026-09-17: an existing article AND a
    // position inside the top 20. The comment above says a ranking is a test
    // result; the code required an article as well, so a term Google shows
    // the site for on page three - "ranking coach alternative", position 29,
    // 171 impressions - was still handed to the vocabulary filter and told
    // "coach" does not appear anywhere on the site. It does not. Google
    // shows the site anyway. Measured demand behind the position is the
    // test result, with or without an article; the article only decides
    // write-vs-refresh, and that is handled above.
    const proven = position !== null && (position <= 20 || (impressions ?? 0) >= STRIKING_MEASURED_MIN_IMPRESSIONS);
    // An audience topic is, by construction, worded in the audience's terms
    // and not the site's: a coaching SaaS has no page with "stipendio" or
    // "codice ATECO" on it, which is the point of writing one. The buyer test
    // has already read the phrase against the business and kept it; the
    // vocabulary filter would then score it 3.5 against 27.8 for a product
    // term (fitsuite.co, 2026-09-20) and put it behind a hundred skipped rows,
    // where the first plan never reaches it.
    const vouched = proven || funnel === "audience";
    const relevance = proven
      ? { score: 1, matched: [], unmatched: [], reason: "the site already ranks for this" }
      : funnel === "audience"
        ? { score: 1, matched: [], unmatched: [], reason: "a question your audience asks, in their words rather than the site's" }
        : scoreRelevance(k.term as string, profile, subject);
    // Squared, so a half-relevant term (one word of two on the site) is
    // worth a quarter of a fully on-topic one, not half. Volume differences
    // are logarithmic here; relevance has to be able to outvote them.
    if (!vouched) {
      score *= RELEVANCE_FLOOR + (1 - RELEVANCE_FLOOR) * relevance.score * relevance.score;
    }
    // Named the buyer, not just the category. Applies to proven rows too: a
    // term the site already ranks for AND that names a confirmed audience is
    // the best row in the table, and the `proven` branch above would otherwise
    // flatten it to the same 1.0 as every other ranking term.
    if (k.source_type === "audience") {
      score *= AUDIENCE_BOOST;
      const who = typeof k.source_ref === "string" && k.source_ref.trim() ? k.source_ref.trim() : null;
      reasons.push(who ? `names ${who}, an audience you told us you sell to` : "names an audience you told us you sell to");
    }
    if ((k.term as string).trim().split(/\s+/).length === 1) {
      score *= SINGLE_WORD_PENALTY;
      reasons.push("a one-word head term, hard to win and hard to write to");
    }
    // State it either way.
    //
    // Only pushing the reason on a partial match made the strongest case for a
    // pick invisible: "sendgrid pricing" was chosen for resend.com because both
    // words are in the site's own vocabulary - it is a direct competitor's
    // pricing query - and the reviewer saw only "1,900 searches/mo, difficulty
    // 9" and had to guess whether the topic fit at all.
    if (proven) {
      // Say it out loud. Without this a ranked pick lost its strongest
      // argument: score 1 and no matched words meant neither branch below
      // fired, so the reviewer saw volume and difficulty and no reason at all.
      reasons.push("the site already ranks for this");
    } else if (relevance.score < 1) {
      reasons.push(relevance.reason);
    } else if (relevance.matched.length > 0) {
      reasons.push(
        `on-topic: ${relevance.matched.slice(0, 4).join(", ")} already appear on the site`,
      );
    }

    // --- Reachability -------------------------------------------------------
    // A keyword the site cannot rank for is not a thing to write; it is a
    // thing to come back to after the authority exists. `relativeDifficulty`
    // has said so since 2026-09-05 and nothing on the writing path asked it:
    // qasimcode.com (authority 0) had a KD 100 term drafted on its first day.
    //
    // Demoted to `skip` rather than hidden, exactly as `suspect` is. The
    // keywords page still shows the row, with the reason, and a human who
    // disagrees can queue it by hand - but `pickNextKeyword` and `buildPlan`
    // both filter on `action === "write"`, so nothing unattended takes it.
    // `refresh` is left alone: a page that already exists and already ranks is
    // not subject to a judgement about winning from nothing.
    // Every filter above asks whether the keyword is *about* this business.
    // This one asks whether it is *for* it. "Running a business without
    // websites" is on-topic by vocabulary, winnable at KD 0, real at 1,600 a
    // month, and informational by intent - and it was written for a studio
    // that sells websites (2026-09-08). Whoever searches it has decided not to
    // buy. `proven` is no defence here: a term the site already ranks for can
    // still be one it should not be writing more about.
    const fit = commercialFit(k.term as string, subject, business?.description ?? null);
    if (fit.fit === "absence") {
      if (action === "write") action = "skip";
      score *= 0.1;
      reasons.push(fit.reason);
    } else if (fit.fit === "substitute") {
      // A penalty, not a refusal: "free" is only misaligned because this
      // business charges, and a reviewer may still want the traffic.
      score *= 0.4;
      reasons.push(fit.reason);
    }

    // Nothing is planned on a guess. Demand is measured when a provider
    // reports searches, when Search Console reports impressions, or when the
    // site already holds a position for the term. A phrase with none of the
    // three is a model's idea of what buyers type: fitsuite.co's first plan
    // (2026-09-19) was four such phrases and one keyword anyone searches.
    // Refused here, before qualification, so no results page is bought for it.
    const measuredDemand = (volume ?? 0) > 0 || (impressions ?? 0) > 0 || position !== null;
    if (action === "write" && !measuredDemand) {
      action = "skip";
      reasons.push("no measured demand: no search volume, no impressions, no ranking");
    }

    if (action === "write" && !proven && isOutOfReach(difficulty, authority)) {
      action = "skip";
      reasons.push(
        authority === null
          ? `difficulty ${difficulty} is out of reach for any site without existing authority`
          : relativeDifficulty(difficulty, authority).reason,
      );
    }

    // The quality heuristic exists for provider fragments - split words,
    // truncated phrases, function-word openers - which is what a keyword
    // index returns. A query with measured impressions is, by definition, a
    // query somebody typed: "better than ranking coach" is a real search
    // that read as "a sentence fragment rather than a query" and was scored
    // at 0.3 with 139 impressions behind it.
    const { quality, note } =
      (impressions ?? 0) >= STRIKING_MEASURED_MIN_IMPRESSIONS
        ? { quality: "ok" as KeywordQuality, note: null }
        : assessKeywordQuality(k.term as string, allTerms);
    if (quality === "suspect" && note) {
      // Scored down as well as flagged, so a suspect term does not sit at the
      // top of a human's queue either.
      score *= 0.3;
      reasons.push(`flagged: ${note}`);
    }

    return {
      keywordId: k.id as string,
      term: k.term as string,
      volume,
      difficulty,
      intent,
      score: Math.round(score * 10) / 10,
      action,
      reasons,
      existingArticleId,
      existingPageUrl,
      currentPosition: position,
      impressions,
      funnel,
      quality,
      qualityNote: note,
    };
  });

  // --- One article per search ------------------------------------------
  // Every keyword row, and every article and page the site already has, goes
  // through one clustering pass (lib/keyword-research/intent.ts): the same
  // results page where both were bought, the same words otherwise. A cluster
  // is led by whatever is furthest along - live, drafted, on the calendar -
  // and then by score.
  //
  //   led by a candidate   the followers are phrasings of one query. They
  //                        leave the list, and the leader says it covers them:
  //                        "agency seo", "agency for seo" and "seo for
  //                        agencies" were three rows worth 27,100 searches
  //                        each, one query triple-counted.
  //   led by something     the search is taken. The follower stays on the
  //   already written      list as a skip with the owner named, and a
  //   or scheduled         qualifying caller parks it, so it is not judged or
  //                        planned again: a real signup (2026-09-22) had one
  //                        Turkish search drafted, queued for the next day and
  //                        held for the trial under three spellings.
  //
  // A row parked for good owns nothing and joins nothing: it is out of the
  // plan, and a refused phrasing must not swallow the one that would pass.
  const rowOf = new Map(keywords.map((k) => [k.id as string, k as unknown as QueueRow]));
  type Topic = StagedTopic & { rec?: KeywordRecommendation; owner?: IntentLeader };
  const leaders = leadersFrom(keywords as unknown as Parameters<typeof leadersFrom>[0], articleRows ?? [], pageRows ?? []);
  const articleById = new Map((articleRows ?? []).map((a) => [a.id, a]));
  const inFlight = new Map(leaders.filter((l) => l.kind === "keyword" && l.keywordId).map((l) => [l.keywordId as string, l]));
  const STAGES: IntentStage[] = ["candidate", "scheduled", "drafted", "live"];
  const further = (a: IntentStage, b: IntentStage | null): IntentStage => (b && STAGES.indexOf(b) > STAGES.indexOf(a) ? b : a);
  const topics: Topic[] = [];
  // Best score first, but a phrasing that can be written ahead of one that
  // cannot: a search is not given up because its highest-volume spelling is
  // provider noise or out of reach.
  const writable = (r: KeywordRecommendation) => (r.action === "write" && r.quality === "ok" ? 0 : 1);
  recommendations.sort((a, b) => b.score - a.score);
  for (const rec of [...recommendations].sort((a, b) => writable(a) - writable(b))) {
    const row = rowOf.get(rec.keywordId);
    if (row && isParkedForGood(row)) continue;
    // In flight on its own row, or covered by an article or a page found by
    // its words: either way the search is already taken.
    const covering = rec.existingArticleId ? articleById.get(rec.existingArticleId) : undefined;
    let stage: IntentStage = inFlight.get(rec.keywordId)?.stage ?? "candidate";
    stage = further(stage, covering ? articleStage(covering.status) : null);
    stage = further(stage, rec.existingPageUrl ? "live" : null);
    topics.push({ term: rec.term, organicUrls: storedSerp(row?.opportunity), stage, rec });
  }
  // Articles and pages with no keyword row of their own lead too; in-flight
  // rows are already in the list above, as recommendations.
  for (const owner of leaders) if (owner.kind !== "keyword") topics.push({ ...owner, owner });
  const followers = clusterByIntent(topics, language);
  const dropped = new Set<KeywordRecommendation>();
  const taken: Array<{ rec: KeywordRecommendation; stage: IntentStage; follow: IntentFollower<Topic> }> = [];
  for (const [topic, follow] of followers) {
    const rec = topic.rec;
    if (!rec) continue;
    const leader = follow.leader;
    if (leader.stage === "candidate" && leader.rec) {
      dropped.add(rec);
      if (!leader.rec.reasons.some((r) => r.startsWith("also covers"))) {
        leader.rec.reasons.push(`also covers "${rec.term}" and other phrasings of the same query`);
      }
      continue;
    }
    taken.push({ rec, stage: topic.stage, follow });
  }
  const sorted = recommendations.filter((rec) => !dropped.has(rec));
  // A qualifying caller is about to spend on verdicts, and a verdict needs a
  // profile to judge against. A workspace older than the wizard has none;
  // read the site for one now, once, rather than stamping every term
  // "pending" for want of a column (lib/keyword-research/business-context.ts).
  const ensured = options?.qualify
    ? await ensureBusinessProfile(supabase, workspaceId, workspace?.domain, business)
    : { business, inferred: false, missing: null };
  const context = { business: ensured.business, domain: workspace?.domain ?? "", languageCode: languageCodeOf(workspace?.language), locationCode: workspace?.location_code ?? 2840 };
  const fingerprint = contextKey(context);

  // The searches already taken. Said on the row either way; parked when this
  // caller is about to plan or write, exactly as a refused verdict is.
  const toPark: Array<{ id: string; verdict: Opportunity }> = [];
  for (const { rec, stage, follow } of taken) {
    const leader = follow.leader;
    const row = rowOf.get(rec.keywordId);
    const verdict = duplicateVerdict(
      { ...(row?.opportunity && typeof row.opportunity === "object" ? row.opportunity as Opportunity : { reason: "" } as Opportunity),
        version: OPPORTUNITY_VERSION, context: fingerprint, checkedAt: new Date().toISOString() },
      { term: leader.term, keywordId: leader.rec?.keywordId ?? leader.owner?.keywordId ?? null, stage: leader.stage },
      follow.match,
    );
    rec.reasons.unshift(verdict.reason);
    // Something already written stays written; the reason is all it gets.
    if (stage === "drafted" || stage === "live") continue;
    if (rec.action === "write") rec.action = "skip";
    rec.opportunity = verdict;
    if (row && !isParkedForGood(row)) toPark.push({ id: rec.keywordId, verdict });
  }
  if (options?.qualify && toPark.length) {
    await parkKeywords(supabase, workspaceId, toPark);
    for (const { id, verdict } of toPark) {
      const row = rowOf.get(id);
      if (row) { row.opportunity = verdict; row.plan_excluded_at = new Date().toISOString(); }
    }
  }
  // Only explicit scheduling/generation requests buy fresh evidence. List pages
  // consume saved briefs without triggering provider work during rendering.
  //
  // A parked row is not a candidate. Parked by a verdict: never again without
  // a person. Parked by a person: where they put it. Parked for want of a
  // verdict (the pre-qualification sweep): a candidate again, judged when the
  // queue needs topics (lib/keyword-research/queue.ts).
  const eligible = sorted.filter((rec) => rec.action === "write" && rec.quality === "ok");
  for (const rec of eligible) {
    const row = rowOf.get(rec.keywordId);
    if (row && isParked(row) && !isRequalifiable(row)) {
      rec.action = "skip";
      const cause = (row.opportunity as { cause?: string } | null)?.cause;
      rec.reasons.unshift(isParkedForGood(row) && cause ? `Parked: ${causeLabel(cause)}` : "Parked: taken off the plan by a person");
    }
  }
  const candidateRows = eligible
    .filter((rec) => rec.action === "write")
    .map((rec) => ({ ...rowOf.get(rec.keywordId)!, id: rec.keywordId, term: rec.term }));
  const evidence: Map<string, Opportunity> = options?.qualify
    ? ensured.missing
      // Nothing to judge against and nothing bought: every eligible term
      // carries the same verdict in memory, and the log can say why.
      ? new Map<string, Opportunity>(candidateRows.map((row) => [row.id, {
          version: OPPORTUNITY_VERSION, context: fingerprint, checkedAt: new Date().toISOString(),
          status: "pending", cause: "no_profile", reason: `Topic qualification is blocked: ${ensured.missing}.`,
        }]))
      // Buy verdicts for the best candidates only until the queue holds
      // what the pace will use; a rejection parks the row as it goes.
      : (await refillQualifiedQueue(supabase, workspaceId, candidateRows, context, {
          target: queueTarget(workspace?.auto_generate_weekly_limit as number | null | undefined),
          ...(options.qualifyBatches ? { maxBatches: options.qualifyBatches } : {}),
        })).verdicts
    : new Map(candidateRows.flatMap((row) => { const o = readOpportunity(row.opportunity, fingerprint); return o ? [[row.id, o] as const] : []; }));
  // Fresh approvals, ranked against each other: the first of a search is
  // the one written, the rest wait behind it in memory and are parked once it
  // is on the calendar (the pass above, next time round).
  const clusters: KeywordRecommendation[] = [];
  // Owners with no results page of their own (a crawled page, an article
  // with no keyword row) are only ever compared by words, and in a language
  // without a rule set that means the exact words. Said on every approval it
  // applies to, not assumed away.
  const unfolded = leaders.some((l) => !l.organicUrls?.length) ? unfoldedNote(language) : null;
  for (const rec of eligible) {
    if (rec.action !== "write") continue;
    const o = evidence.get(rec.keywordId);
    rec.opportunity = o;
    if (o?.status === "qualified") {
      const topic = { term: rec.term, organicUrls: o.organicUrls ?? null };
      const duplicate = clusters.find((other) => sameIntent(topic, { term: other.term, organicUrls: other.opportunity?.organicUrls ?? null }, language).same);
      if (duplicate) {
        rec.action = "skip";
        rec.reasons.push(`Same search as “${duplicate.term}”, which is ahead of it in the queue; one article per search.`);
      } else {
        clusters.push(rec);
        rec.reasons.unshift(o.reason);
        if (unfolded) rec.reasons.push(`Checked against your existing pages by exact words: ${unfolded}.`);
      }
    } else if (options?.qualify || o) {
      rec.action = o?.existingUrl ? "refresh" : "skip";
      rec.reasons.unshift(o?.reason ?? "Topic qualification pending: buyer fit and live search evidence are required before automatic writing.");
    }
  }
  return sorted.slice(0, limit);
}

/**
 * The single best keyword to write about next, or null when nothing qualifies.
 *
 * Skips anything already winning and anything already drafted, so a scheduled
 * run does not regenerate the same article every time it fires.
 *
 * `suspect` terms are excluded here and only here. The recommendations list
 * still shows them to a human who can overrule the heuristic; the unattended
 * path refuses them, because the cost of a wrong call is a published article
 * about a keyword that is not a real query.
 */
export function pickNextKeyword(
  recommendations: KeywordRecommendation[],
): KeywordRecommendation | null {
  return recommendations.find((r) => r.action === "write" && r.quality === "ok") ?? null;
}
