// ---------------------------------------------------------------------------
// A first look's topics: suggested, scored, never vetoed into nothing
// ---------------------------------------------------------------------------
//
// Until 2026-10-25 a first look planned through a chain of vetoes: the buyer
// test, a demand floor, reach, then a results-page judge, and any one of them
// could remove a topic. Nothing set a minimum, so a site whose readers are not
// shoppers lost everything: a public-information site (its readers are
// citizens looking for government schemes) found 33 and then 72 searches, saw
// them refused as "not a buyer search" and "no demand", and was told a person
// would follow up. It never saw an article or the trial.
//
// This replaces the chain with a ranking:
//
//   1. Suggest. One model call reads the business, the pages the site has,
//      the searches already found and what similar sites publish, and
//      proposes about twenty searches its readers type - whoever they are.
//   2. Score. Each topic gets fit (the model's), demand (unmeasured is
//      neutral, a measured volume ranks higher), reach (difficulty against
//      the site's authority) and page type (articles win the results page).
//   3. Pick. The best survivor is planned. Only four things remove a topic:
//      a business's name, a navigational search, an off-topic search, and a
//      results page won by product or service pages. The last one spares a
//      search whose words ask a question (`asksQuestion`), and it never
//      removes everything: when every page read is a providers' page, the
//      best of them with an article to cite is planned at lower confidence
//      (lib/onboarding/first-look-plan.ts, the floor).
//
// The article keeps every check it had: the brief written here passes the
// same `readOpportunity` the writer reads before an automatic draft, and the
// draft still goes through the fact check, the claims tied to the site and
// the trust rules (lib/content/trust.ts).

import type { Opportunity } from "./opportunity";
import { ARTICLE_SHAPES, OPPORTUNITY_VERSION, canonicalPage, validArticleAngle, type ArticleShape } from "./opportunity";
import type { FitProfile } from "./buyer-fit";
import { describeBusiness } from "./buyer-model";
import { isBrandTerm } from "./seeds";
import { rivalNamed, type ResultsPageReading } from "./results-page";
import { relativeDifficulty } from "@/lib/seo/difficulty";
import { classifyIntent } from "@/lib/seo/intent";

/** How many searches the suggestion asks for. */
export const SUGGESTED_TOPICS = 20;

/** Below this fit a topic is off-topic for the site, whatever else it has. */
export const MIN_FIT = 2;

/** What the model says a search is. Only `question` is an article search; the rest are refused or penalised. */
export type TopicKind = "question" | "transactional" | "navigational" | "brand" | "offtopic";
const TOPIC_KINDS: readonly TopicKind[] = ["question", "transactional", "navigational", "brand", "offtopic"];

export interface SuggestedTopic {
  /** The search as typed, lower case. */
  query: string;
  /** Copied from the searches already found for the site. */
  fromList: boolean;
  /** Who types it. */
  reader: string;
  /** What they are trying to get done. */
  job: string;
  /** What on the site helps them next. */
  offering: string;
  /** The article's headline. */
  angle: string;
  shape: ArticleShape;
  /** 1-5: how squarely the site's readers ask this. */
  fit: number;
  kind: TopicKind;
  /** One sentence: why this site should write it. */
  why: string;
}

export interface PoolTerm {
  term: string;
  volume: number | null;
  difficulty: number | null;
  /** Where the site already ranks for it. */
  position?: number | null;
  /** The buyer test refused it (an earlier, buyers-only check). */
  parked?: boolean;
}

export interface SuggestInput {
  business: FitProfile;
  domain: string;
  /** The market's language, as a name ("English", "Italian"). */
  language: string;
  /** The site's own pages: what not to write again. */
  pages: ReadonlyArray<{ title: string; path: string }>;
  /** Searches already found for the site. */
  pool: ReadonlyArray<PoolTerm>;
  /** Similar sites' published pages, read from their sitemaps, as slug words. */
  rivalPages: ReadonlyArray<{ rival: string; pages: string[] }>;
}

const PAGES_SHOWN = 40;
const POOL_SHOWN = 80;
const RIVAL_PAGES_SHOWN = 25;

/** The one prompt. Instructions first, then the site's data. */
export function suggestTopicsPrompt(input: SuggestInput): string {
  const pool = [...input.pool]
    .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || a.term.localeCompare(b.term))
    .slice(0, POOL_SHOWN)
    .map((p) => {
      const facts = [
        p.volume !== null && p.volume > 0 ? `${p.volume}/month` : "volume not measured",
        p.difficulty !== null ? `difficulty ${p.difficulty}` : "",
        p.position ? `site ranks #${p.position}` : "",
        p.parked ? "an earlier buyers-only check refused it" : "",
      ].filter(Boolean).join(", ");
      return `- ${p.term} (${facts})`;
    });
  const pages = input.pages.slice(0, PAGES_SHOWN).map((p) => `- ${p.title} (${p.path})`);
  const rivals = input.rivalPages
    .filter((r) => r.pages.length)
    .map((r) => `- ${r.rival}: ${r.pages.slice(0, RIVAL_PAGES_SHOWN).join("; ")}`);
  return [
    `You choose the first article for a website. Propose ${SUGGESTED_TOPICS} searches its readers type into Google that one article on this site could answer well.`,
    "",
    "Readers are whoever the site serves: buyers, patients, citizens, parents, students, hobbyists, professionals. Not only people about to buy. A public-information site's readers are the public; a clinic's are patients; a shop's are people choosing, using and caring for what it sells.",
    "",
    "Rules:",
    "- A search is the words a person types: 2 to 8 words, lower case, in the market's language, no site or business names.",
    "- When a search below fits, copy it exactly and set fromList to true. Add new searches for what readers ask that the list misses.",
    "- Every search must be one an article answers: a question, a how-to, a guide, an explainer, a checklist, a comparison of options or approaches (never of named businesses).",
    "- Do not propose a search one of the site's own pages already answers.",
    "- kind: \"question\" for a search an article answers; \"transactional\" when the person wants to buy, book, hire or download now; \"navigational\" when they want one specific site, login, portal, office or app; \"brand\" when the search names a business, product brand or person; \"offtopic\" when it is outside what the site covers. Propose question searches; use the other kinds only to label a list search you judged.",
    "- fit, 1 to 5: 5 = the site's core readers ask this and the site can answer it with authority; 4 = its readers ask it and it leads to what the site offers; 3 = adjacent; 2 = a stretch; 1 = not this site's reader.",
    "- reader: who types it, in a few words. job: what they are trying to get done. offering: what on this site helps them next. angle: the article's headline, at most 90 characters, no year unless the search has one. shape: comparison, listicle, howTo, explainer or reference. why: one sentence on why this site should write it.",
    "- Health, money, legal and public-benefit topics: propose only what this site can answer responsibly from what it does; prefer explaining eligibility, steps and documents over advice.",
    "- Order the topics best first: the article you would write first leads. Equal scores are broken by your order.",
    "",
    "Reply with JSON only, no prose: {\"topics\": [{\"query\", \"fromList\", \"reader\", \"job\", \"offering\", \"angle\", \"shape\", \"fit\", \"kind\", \"why\"}]}",
    "",
    "The site:",
    describeBusiness({ ...input.business, language: input.language }),
    `Domain: ${input.domain.replace(/^https?:\/\//, "")}`,
    "",
    pages.length ? `Pages the site already has:\n${pages.join("\n")}` : "Pages the site already has: none read.",
    "",
    pool.length ? `Searches already found for this site:\n${pool.join("\n")}` : "Searches already found for this site: none.",
    "",
    rivals.length ? `What similar sites publish:\n${rivals.join("\n")}` : "What similar sites publish: not read.",
  ].join("\n");
}

/** Where the instructions end and the site's data begins: the cached part of the prompt. */
export function suggestCachePrefix(prompt: string): number {
  const at = prompt.indexOf("\nThe site:\n");
  return at === -1 ? 0 : at + 1;
}

export const SUGGEST_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["topics"],
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["query", "fromList", "reader", "job", "offering", "angle", "shape", "fit", "kind", "why"],
        properties: {
          query: { type: "string" },
          fromList: { type: "boolean" },
          reader: { type: "string" },
          job: { type: "string" },
          offering: { type: "string" },
          angle: { type: "string" },
          shape: { type: "string", enum: [...ARTICLE_SHAPES] },
          fit: { type: "integer" },
          kind: { type: "string", enum: [...TOPIC_KINDS] },
          why: { type: "string" },
        },
      },
    },
  },
};

/**
 * Twice what twenty topics take. Measured at about 200 output tokens a
 * topic, not the 120 first guessed: on 2026-10-27 a reply used all 4,000,
 * stopped inside the last topic, and the run planned nothing.
 */
export const SUGGEST_MAX_TOKENS = 8_000;
export const SUGGEST_MIN_TOKENS = 2_000;

/** The same search, however it was spaced or cased. */
export const topicKey = (query: string) => query.trim().toLowerCase().replace(/\s+/g, " ");

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

/**
 * The topics in a reply, each complete or dropped, first phrasing of a
 * search kept. Never throws: an unusable reply is an empty list.
 */
export function parseSuggestions(raw: unknown): SuggestedTopic[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as { topics?: unknown }).topics : null;
  if (!Array.isArray(list)) return [];
  const out: SuggestedTopic[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const query = topicKey(text(o.query, 120));
    const words = query.split(" ").filter(Boolean).length;
    if (!query || words < 1 || words > 12 || seen.has(query)) continue;
    const fit = typeof o.fit === "number" && Number.isFinite(o.fit) ? Math.max(1, Math.min(5, Math.round(o.fit))) : null;
    const kind = TOPIC_KINDS.includes(o.kind as TopicKind) ? (o.kind as TopicKind) : null;
    const shape = ARTICLE_SHAPES.includes(o.shape as ArticleShape) ? (o.shape as ArticleShape) : "explainer";
    const topic: SuggestedTopic = {
      query,
      fromList: o.fromList === true,
      reader: text(o.reader, 200),
      job: text(o.job, 300),
      offering: text(o.offering, 300),
      angle: text(o.angle, 160),
      shape,
      fit: fit ?? 0,
      kind: kind ?? "question",
      why: text(o.why, 300),
    };
    if (!fit || !kind || !topic.reader || !topic.job || !topic.offering || !topic.why) continue;
    seen.add(query);
    out.push(topic);
  }
  return out;
}

/**
 * The complete topics of a reply cut off before its JSON closed: each topic
 * object that closed, in order, and nothing of the one it stopped inside.
 * Whole JSON is `extractJson`'s job; this is only for what it cannot parse.
 */
export function salvageTopics(raw: string | null): unknown[] {
  if (!raw) return [];
  const key = raw.indexOf('"topics"');
  const start = raw.indexOf("[", key === -1 ? 0 : key);
  if (start === -1) return [];
  const out: unknown[] = [];
  let depth = 0;
  let from = -1;
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth++ === 0) from = i;
    } else if (c === "}") {
      if (--depth < 0) break;
      if (depth === 0) {
        try {
          out.push(JSON.parse(raw.slice(from, i + 1)));
        } catch {
          // a malformed topic is dropped like an incomplete one
        }
      }
    } else if (c === "]" && depth === 0) break;
  }
  return out;
}

// --- Scoring -----------------------------------------------------------------

/** How much each part counts. Fit leads: it is the one read of the site itself. */
export const SCORE_WEIGHTS = { fit: 0.4, demand: 0.2, reach: 0.15, page: 0.25 } as const;

/** What an unmeasured demand scores: neutral, not zero. A measured volume always scores above it. */
export const UNMEASURED_DEMAND = 0.5;
/** Reach when difficulty is not measured. */
export const UNMEASURED_REACH = 0.6;
/** Page type before the results page is read. */
export const UNREAD_PAGE = 0.5;

/** 0-1. Unmeasured (null or 0) is neutral; 10 a month is just above it, 10,000 is the top. */
export function demandScore(volume: number | null | undefined): number {
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume <= 0) return UNMEASURED_DEMAND;
  return Math.min(1, UNMEASURED_DEMAND + 0.05 + 0.45 * (Math.log10(volume + 1) / 4));
}

/** 0-1: how winnable the search is for this site (lib/seo/difficulty.ts). */
export function reachScore(difficulty: number | null | undefined, authority: number | null | undefined): number {
  if (typeof difficulty !== "number" || !Number.isFinite(difficulty)) return UNMEASURED_REACH;
  const { relative } = relativeDifficulty(difficulty, authority);
  if (relative === null) return Math.max(0.05, 1 - difficulty / 100);
  return Math.max(0.05, 1 - relative / 100);
}

/** What a read results page says about an article's chances. */
export interface PageRead {
  /** The page-type reading (lib/keyword-research/results-page.ts). */
  reading: Pick<ResultsPageReading, "type" | "why" | "summary" | "editorialUrls" | "results">;
  /** A page of this site already in the results. */
  ownUrl?: string;
}

/** 0-1. Articles winning the page score highest; unread is neutral. */
export function pageScore(read: PageRead | null | undefined): number {
  if (!read) return UNREAD_PAGE;
  const { type, why } = read.reading;
  let score =
    type === "editorial" ? 1 :
    type === "mixed" ? 0.7 :
    type === "other" && why === "few_articles" ? 0.35 :
    type === "other" ? 0.2 :
    0;
  // The site already has a page in these results: an article would compete with it.
  if (read.ownUrl) score = Math.min(score, 0.25);
  return score;
}

export interface TopicScore {
  /** 0-100. */
  total: number;
  fit: number;
  demand: number;
  reach: number;
  page: number;
  demandMeasured: boolean;
  pageRead: boolean;
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

export function scoreTopic(
  topic: Pick<SuggestedTopic, "fit" | "kind">,
  signals: { volume: number | null; difficulty: number | null; authority: number | null; page?: PageRead | null },
): TopicScore {
  // A search the person wants to act on now can still be an article search;
  // the results page decides that. It just starts lower.
  const fit = Math.max(0, (topic.fit - 1) / 4) * (topic.kind === "transactional" ? 0.6 : 1);
  const demand = demandScore(signals.volume);
  const reach = reachScore(signals.difficulty, signals.authority);
  const page = pageScore(signals.page);
  const w = SCORE_WEIGHTS;
  return {
    total: round(100 * (w.fit * fit + w.demand * demand + w.reach * reach + w.page * page), 1),
    fit: round(fit),
    demand: round(demand),
    reach: round(reach),
    page: round(page),
    demandMeasured: demand !== UNMEASURED_DEMAND,
    pageRead: Boolean(signals.page),
  };
}

/** The most a topic could score once its results page is read: what decides whether reading more is worth it. */
export function bestCase(score: TopicScore): number {
  return round(score.total + 100 * SCORE_WEIGHTS.page * (1 - score.page), 1);
}

// --- What removes a topic ----------------------------------------------------

export type HardReject = "brand" | "navigational" | "offtopic" | "needs_page";

export const HARD_REJECT_WORDS: Record<HardReject, string> = {
  brand: "names a business",
  navigational: "looks for one site",
  offtopic: "off topic",
  needs_page: "results are product or service pages",
};

/** Business names a phrase must not carry: the rivals the person named and the ones found in their results. */
export function namedBusinesses(business: FitProfile | null | undefined): string[] {
  return [...(business?.competitors ?? []), ...(business?.competitorNames ?? []), ...(business?.searchRivals ?? [])]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/** Before any results page: the model's own labels, the site's and its rivals' names. */
export function rejectBeforeResults(
  topic: Pick<SuggestedTopic, "query" | "kind" | "fit">,
  ctx: { domain: string; business: FitProfile | null | undefined },
): HardReject | null {
  if (topic.kind === "brand") return "brand";
  if (topic.kind === "navigational") return "navigational";
  if (topic.kind === "offtopic" || topic.fit < MIN_FIT) return "offtopic";
  const named = namedBusinesses(ctx.business);
  // The site's own name or a rival's, anywhere in the phrase: a search for
  // that business, or about it, is not the article this site should write.
  if (isBrandTerm(topic.query, ctx.domain, named) || rivalNamed(topic.query, [ctx.domain, ...named])) return "brand";
  return null;
}

/**
 * The words alone ask a question: "how to", "what is", "ideas", "tips", "vs",
 * by the intent lexicon (lib/seo/intent.ts), with no results page consulted.
 * False for a language the lexicon does not cover: there the words say
 * nothing either way, and the results page decides as before.
 *
 * Providers' pages crowding the results do not make "garden office ideas" a
 * landing-page search: whoever types it wants an answer, and an article
 * gives one. Its page type still scores 0, so a search articles win ranks
 * above it.
 */
export function asksQuestion(query: string, languageCode: string): boolean {
  const read = classifyIntent(query, languageCode);
  return read.lexicon && read.intent === "info" && read.signals.some((s) => s.intent === "info" && s.weight > 0);
}

/** A results page that providers' own pages win: a service or a local page. */
export const crowdedByProviders = (reading: Pick<ResultsPageReading, "type">): boolean => reading.type === "service" || reading.type === "local";

/**
 * Once the results page is read: who it belongs to and what wins it. A
 * providers' page does not remove a search whose words ask a question.
 */
export function rejectOnResults(reading: Pick<ResultsPageReading, "type" | "why">, opts: { question?: boolean } = {}): HardReject | null {
  if (reading.type === "navigational") return "navigational";
  if (crowdedByProviders(reading) && !opts.question) return "needs_page";
  if (reading.type === "other" && reading.why === "offtopic") return "offtopic";
  return null;
}

/**
 * The pages an article would stand beside: the articles in the results,
 * then the discussion an article would answer. What the brief cites, and
 * what the writer's own check asks for (`readOpportunity`: two, or one at
 * lower confidence).
 */
export function evidenceOf(reading: Pick<ResultsPageReading, "editorialUrls" | "results">): string[] {
  const discussion = reading.results.filter((r) => r.kind === "discussion").sort((a, b) => a.rank - b.rank).map((r) => r.url);
  return [...reading.editorialUrls, ...discussion].filter((url) => canonicalPage(url)).slice(0, 5);
}

// --- The brief ---------------------------------------------------------------

export interface ChosenTopic {
  topic: SuggestedTopic;
  score: TopicScore;
  volume: number | null;
  difficulty: number | null;
  page: PageRead;
  organicUrls: string[];
}

/** "62/100: fit 0.75, demand unmeasured, reach 0.60, page 1.00 (articles win it)". For the log and the run row. */
export function describeScore(score: TopicScore, volume?: number | null): string {
  const demand = score.demandMeasured ? `demand ${score.demand.toFixed(2)} (${volume ?? "?"}/month)` : "demand unmeasured";
  return `${score.total}/100: fit ${score.fit.toFixed(2)}, ${demand}, reach ${score.reach.toFixed(2)}, page ${score.page.toFixed(2)}`;
}

/** Why the article was chosen, in the customer's words: the article's selection reasons. */
export function selectionReasons(chosen: Pick<ChosenTopic, "topic" | "score" | "volume" | "page">): string[] {
  const { topic, score, volume } = chosen;
  return [
    topic.why,
    score.demandMeasured
      ? `About ${volume!.toLocaleString("en-US")} searches a month in your market.`
      : "No search volume is reported for it in your market yet, so demand is unmeasured: it was chosen for how well it fits your readers.",
    chosen.page.reading.type === "editorial" || chosen.page.reading.type === "mixed"
      ? "Articles are what rank for it today."
      : crowdedByProviders(chosen.page.reading)
        ? "Providers' own pages win most of this search today; an article answers the question its readers ask around it."
        : "Few articles rank for it yet, so a good one has room.",
  ];
}

function onSite(url: string | null | undefined, home: string): boolean {
  const host = (u: string) => canonicalPage(u)?.split(/[/?]/)[0] ?? null;
  return Boolean(url && host(url) && host(url) === host(home));
}

/**
 * The search itself as a headline, when the model's own is unusable (dated,
 * empty, too long): "how to choose a garden office" reads as one. A topic is
 * not lost to its headline; the writer titles the article from its research.
 */
export function fallbackAngle(query: string): string {
  const q = query.trim().replace(/\s+/g, " ").slice(0, 160);
  return q ? q[0].toUpperCase() + q.slice(1) : "";
}

const RELATED_STOP = new Set(["a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "is", "are", "do", "does", "how", "what", "which", "why", "when", "who", "vs", "versus", "best", "my", "your", "i", "you", "it", "with", "near", "me"]);
const contentWords = (query: string) => [...new Set(topicKey(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !RELATED_STOP.has(w)))];

/**
 * 0-1: how much of the shorter search's content words the other shares.
 * "garden office cost" and "how much does a garden office cost" are the same
 * subject; "garden office cost" and "office chair reviews" are not.
 */
export function relatedness(a: string, b: string): number {
  const x = contentWords(a);
  const y = new Set(contentWords(b));
  if (!x.length || !y.size) return 0;
  const shared = x.filter((w) => y.has(w)).length;
  return shared / Math.min(x.length, y.size);
}

/** Two searches close enough that an article ranking for one is evidence an article can answer the other. */
export const RELATED_MIN = 0.6;

/** Evidence read from a related search's results page (lib/onboarding/first-look-plan.ts, the last floor). */
export interface BorrowedEvidence {
  /** The related search. */
  from: string;
  /** Its articles and discussions, best first. */
  urls: string[];
}

/**
 * The best related search with something to cite, among the pages this run
 * read. Null when none is close enough: evidence is never borrowed from an
 * unrelated search to satisfy the writer's check.
 */
export function relatedEvidence(query: string, read: ReadonlyArray<{ query: string; evidence: readonly string[] }>): BorrowedEvidence | null {
  let best: { from: string; urls: string[]; score: number } | null = null;
  for (const page of read) {
    if (topicKey(page.query) === topicKey(query) || !page.evidence.length) continue;
    const score = relatedness(query, page.query);
    if (score < RELATED_MIN) continue;
    if (!best || score > best.score || (score === best.score && page.evidence.length > best.urls.length)) best = { from: page.query, urls: [...page.evidence].slice(0, 3), score };
  }
  return best ? { from: best.from, urls: best.urls } : null;
}

export type FirstLookRung = NonNullable<Opportunity["rung"]>;

/**
 * The brief the writer reads, as a qualified verdict (lib/keyword-research/
 * opportunity.ts `Opportunity`). Null when it would not pass the writer's own
 * check (`readOpportunity`): no article or discussion to cite, in this
 * search's results or, with `borrowed`, in a related search's.
 */
export function topicBrief(
  chosen: ChosenTopic,
  ctx: { fingerprint: string; domain: string; conversionUrl?: string | null; now?: Date; borrowed?: BorrowedEvidence | null; rung?: FirstLookRung },
): Opportunity | null {
  const own = evidenceOf(chosen.page.reading).filter((url) => chosen.organicUrls.includes(url));
  const borrowed = own.length === 0 && ctx.borrowed ? ctx.borrowed.urls.filter((url) => canonicalPage(url)).slice(0, 3) : [];
  const evidence = own.length ? own : borrowed;
  if (evidence.length === 0) return null;
  const brief = briefFields(chosen, ctx);
  // One article to cite, a page providers' own pages win, or evidence from
  // a related search: planned, and said to be lower confidence (the
  // planning line and the card say so).
  const lower = evidence.length < 2 || crowdedByProviders(chosen.page.reading) || borrowed.length > 0;
  return {
    ...brief,
    reason: `${brief.reason}${borrowed.length ? ` No article ranks for this exact search; the ${borrowed.length === 1 ? "article" : "articles"} cited rank${borrowed.length === 1 ? "s" : ""} for the related search "${ctx.borrowed!.from}".` : ""}`.slice(0, 400),
    evidenceUrls: evidence,
    organicUrls: borrowed.length ? [...chosen.organicUrls, ...borrowed.filter((url) => !chosen.organicUrls.includes(url))] : chosen.organicUrls,
    ...(lower ? { confidence: "lower" as const } : {}),
    ...(borrowed.length ? { evidenceFrom: ctx.borrowed!.from } : {}),
    ...(ctx.rung ? { rung: ctx.rung } : {}),
  };
}

/** Everything a brief says but what it cites. */
function briefFields(chosen: ChosenTopic, ctx: { fingerprint: string; domain: string; conversionUrl?: string | null; now?: Date }): Opportunity {
  // A headline the model dated is replaced, not a reason to plan nothing.
  const angle = validArticleAngle(chosen.topic.angle, chosen.topic.query) ? chosen.topic.angle : fallbackAngle(chosen.topic.query);
  const home = `https://${ctx.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  const demandLine = chosen.score.demandMeasured
    ? `About ${chosen.volume!.toLocaleString("en-US")} searches a month.`
    : "No search volume is reported for it in this market yet (unmeasured); chosen for fit.";
  return {
    version: OPPORTUNITY_VERSION,
    context: ctx.fingerprint,
    checkedAt: (ctx.now ?? new Date()).toISOString(),
    status: "qualified",
    reason: `${chosen.topic.why} ${demandLine} ${chosen.page.reading.summary}`.replace(/\s+/g, " ").trim().slice(0, 400),
    audience: chosen.topic.reader,
    buyingJob: chosen.topic.job,
    offering: chosen.topic.offering,
    angle,
    format: chosen.page.reading.type === "mixed" ? "mixed" : "article",
    shape: chosen.topic.shape,
    // A model cannot invent or redirect the product's destination: the
    // profile's own page on this site, or the home page.
    conversionPath: onSite(ctx.conversionUrl, home) ? ctx.conversionUrl! : home,
    evidenceUrls: [],
    organicUrls: chosen.organicUrls,
    ...(chosen.score.demandMeasured ? {} : { demand: "unmeasured" as const }),
    firstLookScore: { ...chosen.score },
  };
}

/**
 * The last rung's brief: a search whose results page was read and that has
 * nothing to cite, in its own results or a related search's. Lower
 * confidence, citing nothing, and saying so; the writer researches the
 * search itself and the draft's facts go through the fact check as any
 * other's. What keeps a first look that knows the business from ending with
 * no article.
 */
export function uncitedBrief(chosen: ChosenTopic, ctx: { fingerprint: string; domain: string; conversionUrl?: string | null; now?: Date }): Opportunity {
  const brief = briefFields(chosen, ctx);
  return {
    ...brief,
    // The sentence that says why it is lower confidence is never the part cut.
    reason: `${brief.reason.slice(0, 320).trim()} No published article ranks for this search to check it against.`,
    evidenceUrls: [],
    confidence: "lower",
    rung: "uncited",
    uncited: true,
  };
}

// --- The topic proposed to the owner -----------------------------------------

/**
 * The one direction proposed when nothing could be planned with evidence the
 * writer accepts: the topic, why, and what a "write this" needs to turn it
 * into a brief. Shown to the owner on the run's screen and kept on the run's
 * row; no source is named that was not observed.
 */
export interface FirstLookProposal {
  term: string;
  angle: string;
  why: string;
  reader: string;
  job: string;
  offering: string;
  shape: ArticleShape;
  volume: number | null;
  difficulty: number | null;
  score: TopicScore;
  /** Whether this search's results page was read before it was proposed. */
  checked: boolean;
  /** What the results page showed, in a sentence, when it was read. */
  results?: string;
  organicUrls: string[];
}

export function proposalOf(chosen: Omit<ChosenTopic, "page"> & { page?: PageRead }): FirstLookProposal {
  const { topic } = chosen;
  return {
    term: topic.query,
    angle: validArticleAngle(topic.angle, topic.query) ? topic.angle : fallbackAngle(topic.query),
    why: topic.why,
    reader: topic.reader,
    job: topic.job,
    offering: topic.offering,
    shape: topic.shape,
    volume: chosen.volume,
    difficulty: chosen.difficulty,
    score: { ...chosen.score },
    checked: Boolean(chosen.page),
    ...(chosen.page ? { results: chosen.page.reading.summary } : {}),
    organicUrls: chosen.organicUrls.slice(0, 10),
  };
}

const proposalText = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A proposal read back off a run's row: complete, or null. */
export function readProposal(raw: unknown): FirstLookProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<FirstLookProposal>;
  const term = topicKey(proposalText(o.term, 120));
  const fields = { angle: proposalText(o.angle, 160), why: proposalText(o.why, 300), reader: proposalText(o.reader, 200), job: proposalText(o.job, 300), offering: proposalText(o.offering, 300) };
  const score = o.score as TopicScore | undefined;
  if (!term || Object.values(fields).some((v) => !v) || !score || typeof score.total !== "number") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    term,
    ...fields,
    shape: ARTICLE_SHAPES.includes(o.shape as ArticleShape) ? (o.shape as ArticleShape) : "explainer",
    volume: num(o.volume),
    difficulty: num(o.difficulty),
    score: { total: score.total, fit: Number(score.fit) || 0, demand: Number(score.demand) || 0, reach: Number(score.reach) || 0, page: Number(score.page) || 0, demandMeasured: score.demandMeasured === true, pageRead: score.pageRead === true },
    checked: o.checked === true,
    ...(proposalText(o.results, 300) ? { results: proposalText(o.results, 300) } : {}),
    organicUrls: Array.isArray(o.organicUrls) ? o.organicUrls.filter((u): u is string => typeof u === "string" && Boolean(canonicalPage(u))).slice(0, 10) : [],
  };
}

/**
 * The brief a proposal becomes once its owner says "write this": lower
 * confidence, citing nothing, with their confirmation where an observed
 * article would be (`readOpportunity`). The writer researches the search
 * itself, and the draft's facts go through the fact check as any other's.
 */
export function ownerConfirmedBrief(proposal: FirstLookProposal, ctx: { fingerprint: string; domain: string; conversionUrl?: string | null; now?: Date }): Opportunity {
  const now = ctx.now ?? new Date();
  const home = `https://${ctx.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return {
    version: OPPORTUNITY_VERSION,
    context: ctx.fingerprint,
    checkedAt: now.toISOString(),
    status: "qualified",
    reason: `${proposal.why} Proposed with no article found to cite for this search, and confirmed by the site's owner.`.replace(/\s+/g, " ").trim().slice(0, 400),
    audience: proposal.reader,
    buyingJob: proposal.job,
    offering: proposal.offering,
    angle: validArticleAngle(proposal.angle, proposal.term) ? proposal.angle : fallbackAngle(proposal.term),
    format: "article",
    shape: proposal.shape,
    conversionPath: onSite(ctx.conversionUrl, home) ? ctx.conversionUrl! : home,
    evidenceUrls: [],
    organicUrls: proposal.organicUrls,
    confidence: "lower",
    ...(proposal.score.demandMeasured ? {} : { demand: "unmeasured" as const }),
    firstLookScore: { ...proposal.score },
    rung: "owner_confirmed",
    ownerConfirmed: now.toISOString(),
  };
}

// --- The second ask ------------------------------------------------------------

/** How many question searches the second ask asks for, and reads at most. */
export const SECOND_ASK_TOPICS = 8;
export const SECOND_ASK_MAX_TOKENS = 3_200;
export const SECOND_ASK_MIN_TOKENS = 1_000;

/**
 * The second ask: when every suggested search was read and none could be
 * planned, the profile's own jobs, offerings and readers turned into
 * searches that are questions by their words ("how to choose...", "what
 * does ... cost", "... checklist", "... vs ..."). A providers' page does not
 * remove such a search (`asksQuestion`), so these are the searches most
 * likely to end in an article. Same reply shape as the first ask.
 */
export function secondAskPrompt(input: { business: FitProfile; domain: string; language: string; tried: readonly string[] }): string {
  const list = (v: string[] | null | undefined) => (v ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 8);
  const jobs = list(input.business.buyingJobs);
  const offerings = list(input.business.offerings);
  const audiences = list(input.business.audiences);
  return [
    `You choose the first article for a website. The searches tried so far are won by providers' own pages or have no article to cite. Propose ${SECOND_ASK_TOPICS} different searches, each a question by its own words, that one article on this site answers.`,
    "",
    "Rules:",
    "- Build each search from what the site's readers are trying to get done, what the site offers and who it serves (listed below): one search per job or offering where you can.",
    `- Every search must start with or contain a question form in the market's language: "how to choose ...", "how much does ... cost", "what is ...", "... checklist", "... vs ..." (two approaches or options, never two named businesses), "questions to ask before ...", "... mistakes to avoid", "is ... worth it".`,
    "- 3 to 9 words, lower case, in the market's language, no site, business or brand names, no place names unless the site serves only that place.",
    "- Do not repeat or rephrase a search already tried.",
    "- kind is \"question\" for every one. fit, 1 to 5: how squarely the site's readers ask it. shape: comparison, listicle, howTo, explainer or reference.",
    "- reader: who types it. job: what they are trying to get done. offering: what on this site helps them next. angle: the article's headline, at most 90 characters, no year. why: one sentence on why this site should write it.",
    "- Health, money, legal and public-benefit topics: only what this site can answer responsibly from what it does.",
    "- Best first.",
    "",
    "Reply with JSON only, no prose: {\"topics\": [{\"query\", \"fromList\", \"reader\", \"job\", \"offering\", \"angle\", \"shape\", \"fit\", \"kind\", \"why\"}]} with fromList false.",
    "",
    "The site:",
    describeBusiness({ ...input.business, language: input.language }),
    `Domain: ${input.domain.replace(/^https?:\/\//, "")}`,
    "",
    jobs.length ? `What its readers are trying to get done:\n${jobs.map((j) => `- ${j}`).join("\n")}` : "What its readers are trying to get done: not listed; infer it from what the site does.",
    offerings.length ? `What it offers:\n${offerings.map((o) => `- ${o}`).join("\n")}` : "What it offers: not listed; infer it from what the site does.",
    audiences.length ? `Who it serves:\n${audiences.map((a) => `- ${a}`).join("\n")}` : "Who it serves: not listed; infer it from what the site does.",
    "",
    input.tried.length ? `Searches already tried:\n${input.tried.slice(0, 40).map((t) => `- ${t}`).join("\n")}` : "Searches already tried: none.",
  ].join("\n");
}
