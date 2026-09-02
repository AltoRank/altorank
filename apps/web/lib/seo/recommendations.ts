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
import { scoreRelevance, type TopicalProfile } from "./topical-profile";

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
  volume: number;
  difficulty: number | null;
  intent: KeywordIntent;
  /** Composite score; only meaningful relative to the other rows. */
  score: number;
  action: RecommendedAction;
  /** Plain-language reasons, in the order they influenced the score. */
  reasons: string[];
  /** Set when an article in this workspace already targets the term. */
  existingArticleId: string | null;
  /** Most recent tracked position, when the rank cron has run. */
  currentPosition: number | null;
  /** Impressions over the GSC lookback window, when Search Console is synced. */
  impressions: number | null;
  quality: KeywordQuality;
  /** Why it was flagged; null when quality is `ok`. */
  qualityNote: string | null;
}

/**
 * Spot keyword-provider noise.
 *
 * `allTerms` is the rest of the tracked set, used to catch split-word variants:
 * "s eo" is junk precisely because "seo" is also tracked, and "zap ier" because
 * "zapier" is. That comparison is what separates a genuine short multi-word
 * query from a mangled single word.
 */
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

  if (tokens.some((t) => t.length === 1)) {
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
  // "ai can", "ai in": the query was cut mid-phrase. Nobody searches that.
  const TRAILING_JUNK = new Set(["can", "in", "for", "and", "the", "of", "to", "is", "with", "on", "by", "or"]);
  if (tokens.length > 1 && TRAILING_JUNK.has(tokens[tokens.length - 1])) {
    return { quality: "suspect", note: `ends with "${tokens[tokens.length - 1]}", a fragment rather than a query` };
  }

  return { quality: "ok", note: null };
}

const GSC_LOOKBACK_DAYS = 90;

/** Words that carry no targeting signal, so two terms differing only by these are one target. */
const STOPWORDS = new Set([
  "a", "an", "the", "for", "and", "or", "of", "to", "in", "on", "with", "is", "are", "my", "your",
]);

/**
 * Collapse a keyword to the target it actually competes for.
 *
 * "agency seo", "agency for seo" and "seo for agencies" are one query with one
 * set of results. Deduping on the raw string treats them as three, and an
 * unattended run will happily write all three, splitting the ranking across
 * pages that cannibalise each other. That is worse than writing nothing: it
 * spends budget to compete with yourself.
 *
 * Caught in a live run, where the cron wrote "agency seo" and then "agency for
 * seo" on consecutive firings.
 *
 * Deliberately crude. Real stemming would need a dictionary per language and
 * this has to work across 36 locales; dropping stopwords, folding common plural
 * endings and sorting catches the overwhelmingly common case, which is word
 * order and connecting words.
 */
export function normalizeTarget(term: string): string {
  return term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) =>
      t.endsWith("ies") && t.length > 4
        ? `${t.slice(0, -3)}y`
        : t.endsWith("es") && t.length > 4
          ? t.slice(0, -2)
          : t.endsWith("s") && !t.endsWith("ss") && t.length > 3
            ? t.slice(0, -1)
            : t,
    )
    .sort()
    .join(" ");
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
 * Volume contributes on a log scale.
 *
 * A 200,000/mo head term is not a hundred times better than a 2,000/mo one: it
 * is far harder, usually broader in intent, and the realistic click share is a
 * fraction of the volume. Linear volume makes the queue nothing but head terms,
 * which is the classic way to spend a year ranking for nothing.
 */
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
function winnability(difficulty: number | null, volume = 0): number {
  if (difficulty === null) return 0.6;
  // Difficulty 0 on a term with real volume is the provider saying "not
  // computed", not "free". Treated as easy it multiplies by 1.0 and floats a
  // fragment like "no keywords" (27,100/mo, KD 0) to the top of the queue.
  if (difficulty === 0 && volume >= 1000) return 0.6;
  const d = Math.min(Math.max(difficulty, 0), 100);
  return 1 - d / 100;
}

/**
 * Commercial and transactional terms are worth marginally more to an agency's
 * client than informational ones, because they sit closer to a sale. Kept small
 * deliberately: intent is a tiebreak, not a thesis, and the classifier is a
 * lexicon rather than an oracle.
 */
const INTENT_WEIGHT: Record<KeywordIntent, number> = {
  transactional: 1.15,
  commercial: 1.1,
  navigational: 0.8,
  info: 1.0,
};

export async function recommendKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
  options?: { limit?: number },
): Promise<KeywordRecommendation[]> {
  const limit = options?.limit ?? 25;

  const { data: keywords, error } = await supabase
    .from("keywords")
    .select("id, term, volume, difficulty, intent, status")
    .eq("workspace_id", workspaceId);

  if (error) throw new Error(`Could not read keywords: ${error.message}`);
  if (!keywords?.length) return [];

  // What this business is actually about. Without it, scoring optimises volume
  // and difficulty alone and will happily recommend a keyword from a completely
  // different industry.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("topical_profile")
    .eq("id", workspaceId)
    .single();

  const profile = (workspace?.topical_profile as TopicalProfile | null) ?? null;

  const keywordIds = keywords.map((k) => k.id as string);
  const allTerms = new Set(keywords.map((k) => (k.term as string).trim().toLowerCase()));

  // --- Signals ------------------------------------------------------------
  // Each of these is optional: a workspace with no rank history and no Search
  // Console still gets a usable queue from volume, difficulty and intent alone.

  const [rankRes, articleRes, gscRes] = await Promise.allSettled([
    supabase
      .from("keyword_rankings")
      .select("keyword_id, position, checked_at")
      .in("keyword_id", keywordIds)
      .order("checked_at", { ascending: false }),
    supabase
      .from("articles")
      .select("id, keyword")
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
      .not("query", "is", null),
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

  // Keyed by normalised target, so an article about "agency seo" is also found
  // when scoring "agency for seo".
  const articleByTerm = new Map<string, string>();
  if (articleRes.status === "fulfilled") {
    for (const a of (articleRes.value.data ?? []) as Array<{
      id: string;
      keyword: string | null;
    }>) {
      if (a.keyword) articleByTerm.set(normalizeTarget(a.keyword), a.id);
    }
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
    const volume = (k.volume as number) ?? 0;
    const difficulty = (k.difficulty as number | null) ?? null;
    const intent = ((k.intent as KeywordIntent) ?? "info") satisfies KeywordIntent;

    const position = latestPosition.get(k.id as string) ?? null;
    const existingArticleId = articleByTerm.get(normalizeTarget(term)) ?? null;
    const impressions = impressionsByTerm.get(term) ?? null;

    const reasons: string[] = [];

    let score = volumeScore(volume);
    if (volume > 0) reasons.push(`${volume.toLocaleString()} searches/mo`);

    // Proven demand on this exact site beats estimated demand anywhere.
    if (impressions && impressions > 0) {
      score += Math.log10(impressions + 1) * 6;
      reasons.push(`${impressions.toLocaleString()} impressions already earned`);
    }

    score *= winnability(difficulty, volume);
    reasons.push(
      difficulty === null
        ? "difficulty unknown, scored conservatively"
        : `difficulty ${difficulty}`,
    );

    score *= INTENT_WEIGHT[intent];

    let action: RecommendedAction = "write";

    if (position !== null && position <= ALREADY_WON) {
      action = "skip";
      score *= 0.15;
      reasons.push(`already ranking at position ${position}, leave it alone`);
    } else if (position !== null && position >= STRIKING_MIN && position <= STRIKING_MAX) {
      action = existingArticleId ? "refresh" : "write";
      score *= 2.5;
      reasons.push(`position ${position} is striking distance, one revision from page one`);
    } else if (position !== null) {
      score *= 1.2;
      reasons.push(`ranking at position ${position}`);
    }

    if (existingArticleId && action === "write") {
      // Writing a second article for a term we already cover splits the ranking
      // between two pages instead of concentrating it on one.
      action = "refresh";
      score *= 0.8;
      reasons.push("an article already targets this, refresh rather than duplicate");
    }

    // --- Relevance ---------------------------------------------------------
    // The third axis. A keyword can be high-volume and easy to win and still be
    // worthless because the business has nothing to say about it.
    const relevance = scoreRelevance(k.term as string, profile);
    score *= RELEVANCE_FLOOR + (1 - RELEVANCE_FLOOR) * relevance.score;
    // State it either way.
    //
    // Only pushing the reason on a partial match made the strongest case for a
    // pick invisible: "sendgrid pricing" was chosen for resend.com because both
    // words are in the site's own vocabulary - it is a direct competitor's
    // pricing query - and the reviewer saw only "1,900 searches/mo, difficulty
    // 9" and had to guess whether the topic fit at all.
    if (relevance.score < 1) {
      reasons.push(relevance.reason);
    } else if (relevance.matched.length > 0) {
      reasons.push(
        `on-topic: ${relevance.matched.slice(0, 4).join(", ")} already appear on the site`,
      );
    }

    const { quality, note } = assessKeywordQuality(k.term as string, allTerms);
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
      currentPosition: position,
      impressions,
      quality,
      qualityNote: note,
    };
  });

  // Collapse variants of one target to their best-scoring representative.
  // Without this the queue shows "agency seo", "agency for seo" and "seo for
  // agencies" as three separate opportunities worth 27,100 searches each, which
  // triple-counts a single one.
  const byTarget = new Map<string, KeywordRecommendation>();
  for (const rec of recommendations.sort((a, b) => b.score - a.score)) {
    const target = normalizeTarget(rec.term);
    const held = byTarget.get(target);
    if (!held) {
      byTarget.set(target, rec);
    } else if (!held.reasons.some((r) => r.startsWith("also covers"))) {
      held.reasons.push(`also covers "${rec.term}" and other phrasings of the same query`);
    }
  }

  return [...byTarget.values()].slice(0, limit);
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
