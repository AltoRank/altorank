// ---------------------------------------------------------------------------
// A first look's plan: suggest, score, pick at least one
// ---------------------------------------------------------------------------
//
// What the onboarding run calls in place of the qualification chain
// (lib/onboarding/pipeline.ts, phase 4). The ranking itself is pure and lives
// in lib/keyword-research/first-look-topics.ts; this reads what it needs,
// makes the one model call, reads results pages for the best few, and writes
// the plan the way `schedulePlan` does: keyword rows, calendar entries, the
// article shape and the owner questions.
//
// One model call where the chain made up to thirty (a results-page judge read,
// twice, for each of fifteen terms). Results pages are read for the best
// candidates only, and only while an unread one could still beat the best
// read one.
//
// Nothing planned is reserved for what is not the site's doing: the model or
// the results provider not answering (`provider`), and a trial hold that is
// already spent or a calendar already full. A topic is never refused for
// having unmeasured demand or for its readers not being shoppers.
//
// Nor is a service business left with nothing because providers' own pages
// win its searches. Every first look of one such site read its twelve
// results pages, removed all twelve as "needs a landing page", and planned
// nothing, so the person never saw an article. Now a search whose words ask a
// question survives a providers' page (`asksQuestion`), and when every page
// read was a providers' page, the best one with an article to cite is planned
// at lower confidence: the floor.
//
// And since 2026-11-22 a site with a usable profile is not left with nothing
// at all. The rungs, in order, each tried only when the one before planned
// nothing:
//
//   ranked            the bar, within MAX_RESULTS_READS results pages
//   extended          the bar, reading on past them while nothing is accepted
//   second_ask        one more model call: question searches from the profile
//   floor             a providers' page with its own article to cite
//   related_evidence  a search with nothing to cite, citing the articles that
//                     rank for a closely related search read in this run
//   uncited           the best search whose results page was read, with
//                     nothing to cite anywhere: planned at lower confidence,
//                     citing nothing, and said so
//
// So a first look that read at least one results page a hard rule did not
// remove for good plans an article. No source is ever invented: the last
// rung's brief cites nothing (`uncitedBrief`).
//
// Only when no page could be read at all (the budget refused them, or the
// deadline came first) is the outcome `needs_owner_input`: a search nobody
// looked at is proposed to the owner, whose "write this" is the confirmation,
// rather than spending their one article on it blind.

import type { SupabaseClient } from "@supabase/supabase-js";
import { PRE_TRIAL_DRAFTS, planHold, type PlanHold } from "@/lib/billing/trial-hold";
import { isBudgetRefusal, withStage } from "@/lib/billing/spend-scope";
import { e2eStubsEnabled, isReservedTestDomain } from "@/lib/e2e/stubs";
import { askStructured, extractJson, modelAvailable, type AskModel } from "@/lib/keyword-research/buyer-model";
import type { FitProfile } from "@/lib/keyword-research/buyer-fit";
import {
  asksQuestion,
  bestCase,
  describeScore,
  evidenceOf,
  HARD_REJECT_WORDS,
  namedBusinesses,
  parseSuggestions,
  proposalOf,
  rejectBeforeResults,
  relatedEvidence,
  SECOND_ASK_MAX_TOKENS,
  SECOND_ASK_MIN_TOKENS,
  SECOND_ASK_TOPICS,
  secondAskPrompt,
  SUGGESTED_TOPICS,
  rejectOnResults,
  salvageTopics,
  scoreTopic,
  selectionReasons,
  SUGGEST_MAX_TOKENS,
  SUGGEST_MIN_TOKENS,
  SUGGEST_SCHEMA,
  suggestCachePrefix,
  suggestTopicsPrompt,
  topicBrief,
  topicKey,
  uncitedBrief,
  type BorrowedEvidence,
  type ChosenTopic,
  type FirstLookProposal,
  type FirstLookRung,
  type HardReject,
  type PageRead,
  type PoolTerm,
  type SuggestedTopic,
  type TopicScore,
} from "@/lib/keyword-research/first-look-topics";
import { languageCodeOf } from "@/lib/keyword-research/locale";
import { fetchTermMetrics } from "@/lib/keyword-research/metrics";
import { contextKey, existingPageIn, judgedResults, type FirstLook, type Opportunity } from "@/lib/keyword-research/opportunity";
import { readResultsPage, type PageKind, type PageType, type ResultKind } from "@/lib/keyword-research/results-page";
import { fetchAdvancedSerp, type SerpData } from "@/lib/seo/brief-data";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { classifyIntent } from "@/lib/seo/intent";
import { looksLikePost, readSiteUrls } from "@/lib/seo/site-urls";
import { decoratePlannedKeywords, type PlannedEntry } from "./plan";
import { nextOpenDates, PLAN_MAX_ENTRIES } from "./plan-limits";
import { timed } from "./timings";

/** Results pages read side by side. */
export const RESULTS_ROUND = 4;
/** Results pages a first look reads at most, once a topic is accepted. While none is, it reads on. */
export const MAX_RESULTS_READS = 12;
/** Results pages a first look reads whatever happens: every suggestion, the second ask's, and no more. */
export const HARD_MAX_READS = SUGGESTED_TOPICS + SECOND_ASK_TOPICS + 4;
/** The least time left before the deadline for the second ask to be worth making. */
const SECOND_ASK_MIN_MS = 20_000;
/** Rivals whose sitemaps are read for what they publish. */
const RIVALS_READ = 3;
/** How long the rival sitemaps may take, all together. Free reads; never in the way. */
const RIVAL_READ_MS = 8_000;
/** The least a write is given, even past the plan's deadline. */
const SAVE_FLOOR_MS = 5_000;

/** Where the plan went, for the run's funnel event (./funnel-event.ts). Counts and the chosen topic only. */
export interface FirstLookSummary {
  suggested: number;
  /** Topics removed, by the one rule that removed each. */
  rejected: Partial<Record<HardReject, number>>;
  /** Results pages read, and the ones the provider did not answer. */
  resultsRead: number;
  resultsFailed: number;
  /** Read and kept, but with no article or discussion in the results to cite. */
  noEvidence: number;
  planned: number;
  /** Kept with a brief and not planned: the topics a trial opens. */
  ready: number;
  /** Planned on a floor (`rung` says which): nothing read passed the bar. */
  floor?: boolean;
  /**
   * Which rung planned the first article: `ranked` (the bar, within the
   * usual reads), `extended` (the bar, reading past them), `second_ask` (a
   * question search from the second ask), `floor` (a providers' page with
   * its own article to cite), `related_evidence` (cited from a related
   * search's results), `uncited` (read, with nothing to cite anywhere).
   * Absent when nothing was planned.
   */
  rung?: FirstLookRung;
  /** Suggested searches read past MAX_RESULTS_READS because nothing was accepted yet. */
  extendedReads?: number;
  /** The second ask, when it was made: the searches it added and how many of their pages were read. */
  secondAsk?: { suggested: number; read: number };
  /** No results page could be read: one unread topic was proposed to the owner. */
  proposed?: boolean;
  /** What ended the reading early, when something did. */
  stopped?: "budget" | "deadline";
  modelCalls: number;
  chosen?: { term: string; score: TopicScore; volume: number | null; line: string };
}

export type FirstLookOutcome =
  /** At least one topic is on the calendar. */
  | "planned"
  /** The trial hold's one pre-trial article was already attempted. */
  | "spent"
  /** The calendar already holds what the plan may hold. */
  | "full"
  /** The model or the results provider did not answer: ours, not the site's. */
  | "provider"
  /** The model answered, but cut off or unreadable before a whole topic: ours too, and not an outage. */
  | "unreadable"
  /**
   * Topics were found and no results page could be read for any of them
   * (the budget, the deadline): `proposal` is the one to show the owner, whose "write this"
   * supplies the confirmation (lib/keyword-research/first-look-topics.ts
   * `ownerConfirmedBrief`).
   */
  | "needs_owner_input"
  /** Every suggestion was removed before any results page: a business's name, one site's search, off topic. */
  | "none";

/**
 * One results page a first look read, compact: the search, what the page
 * type rule made of it, and the judged results with their kinds. Stored
 * with the run (./first-look-replay.ts) so it can be replayed without
 * buying the page again.
 */
export interface FirstLookRead {
  query: string;
  source: "suggested" | "second_ask";
  type: PageType;
  why?: string;
  verdict: "accepted" | "no_evidence" | HardReject;
  results: Array<{ rank: number; url: string; title: string; description: string; domain: string; kind: ResultKind; page: PageKind }>;
}

export interface FirstLookPlanResult {
  plan: PlannedEntry[];
  outcome: FirstLookOutcome;
  summary: FirstLookSummary;
  /** Per planned term: what the article records as why it was chosen. */
  selection: Map<string, { reasons: string[]; score: number; volume: number | null; difficulty: number | null }>;
  /** With `needs_owner_input`: the one topic proposed. */
  proposal?: FirstLookProposal;
  /** Every results page read, in the order read. */
  reads: FirstLookRead[];
  /** What each ask returned, as parsed: with `reads`, the run replayed for free. */
  asked: { suggested: SuggestedTopic[]; secondAsk: SuggestedTopic[] };
}

export interface FirstLookPlanOptions {
  firstLook: FirstLook;
  /** Entries this run may plan for an account the trial does not hold. */
  maxEntries?: number;
  weeklyLimit: number;
  /** The searches being read, named on the screen while it happens. */
  onProgress?: (p: { checking: string[]; judged: number; qualified: number }) => void;
  /** See PlanOptions.questionsInBackground (./plan.ts). */
  questionsInBackground?: (pending: Promise<unknown>) => void;
  /** The model call; tests and the replay pass their own. */
  ask?: AskModel;
  /** The results page; tests and the replay pass their own. */
  serp?: (term: string, locale: { languageCode: string; locationCode: number }) => Promise<SerpData>;
  /** Search volumes for new suggestions; tests and the replay pass their own. */
  metrics?: typeof fetchTermMetrics;
  /** The rivals' published pages; tests and the replay pass their own. */
  rivalPages?: (rivals: string[]) => Promise<Array<{ rival: string; pages: string[] }>>;
  /** The trial hold's answer; the replay passes its own. */
  hold?: () => Promise<PlanHold>;
  /** The planned topics' owner questions; `false` skips them (the replay). */
  decorate?: typeof decoratePlannedKeywords | false;
  now?: Date;
}

interface WorkspaceRow {
  id: string;
  domain: string | null;
  language: string | null;
  location_code: number | null;
  dr: number | null;
  business_profile: unknown;
}

interface KeywordRow {
  id: string;
  term: string;
  volume: number | null;
  difficulty: number | null;
  status: string | null;
  plan_excluded_at: string | null;
  source_url: string | null;
  opportunity: unknown;
}

/** A candidate as it moves through the ranking. */
interface Candidate {
  topic: SuggestedTopic;
  /** Where the model put it: best first. What breaks a tie. */
  order: number;
  /** Which ask proposed it. */
  source: FirstLookRead["source"];
  /** Which rung accepted it. */
  rung?: FirstLookRung;
  row: KeywordRow | null;
  volume: number | null;
  difficulty: number | null;
  score: TopicScore;
  page?: PageRead;
  organicUrls?: string[];
  brief?: Opportunity;
}

const emptySummary = (): FirstLookSummary => ({ suggested: 0, rejected: {}, resultsRead: 0, resultsFailed: 0, noEvidence: 0, planned: 0, ready: 0, modelCalls: 0 });

export async function planFirstLook(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: FirstLookPlanOptions,
): Promise<FirstLookPlanResult> {
  const summary = emptySummary();
  const selection: FirstLookPlanResult["selection"] = new Map();
  const reads: FirstLookRead[] = [];
  const asked: FirstLookPlanResult["asked"] = { suggested: [], secondAsk: [] };
  const nothing = (outcome: FirstLookOutcome): FirstLookPlanResult => ({ plan: [], outcome, summary, selection, reads, asked });

  // The trial hold decides how many (lib/billing/trial-hold.ts), as it does
  // for every planner: one article before the trial, nothing once it is spent.
  const hold = opts.hold ? await opts.hold() : await planHold(supabase, workspaceId);
  if (hold === "spent") return nothing("spent");
  const cap = hold === "held" ? PRE_TRIAL_DRAFTS : Math.min(PLAN_MAX_ENTRIES, opts.maxEntries ?? PLAN_MAX_ENTRIES);
  const { data: entries } = await supabase
    .from("calendar_entries")
    .select("keyword_id, keyword, scheduled_date, article_id, status")
    .eq("workspace_id", workspaceId)
    .in("status", ["queue", "scheduled"]);
  // Like `schedulePlan`'s replace mode: a queued entry with no article is
  // laid out again; anything scheduled or written stays and counts.
  const kept = ((entries ?? []) as Array<{ keyword_id: string | null; keyword: string | null; scheduled_date: string; article_id: string | null; status: string }>)
    .filter((e) => e.status !== "queue" || e.article_id);
  const room = cap - kept.length;
  if (room <= 0) return nothing("full");

  const [{ data: ws, error: wsError }, { data: keywordRows }, { data: pageRows }] = await Promise.all([
    supabase.from("workspaces").select("id, domain, language, location_code, dr, business_profile").eq("id", workspaceId).maybeSingle(),
    supabase.from("keywords").select("id, term, volume, difficulty, status, plan_excluded_at, source_url, opportunity").eq("workspace_id", workspaceId).limit(1000),
    supabase.from("site_pages").select("url, path, title, h1").eq("workspace_id", workspaceId).limit(200),
  ]);
  if (wsError || !ws) throw new Error(`Could not read this site to plan it${wsError ? `: ${wsError.message}` : ""}.`);
  const workspace = ws as WorkspaceRow;
  const domain = (workspace.domain ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const business = (workspace.business_profile ?? null) as (FitProfile & { conversionUrl?: string | null }) | null;
  const languageCode = languageCodeOf(workspace.language);
  const locale = { languageCode, locationCode: workspace.location_code ?? 2840 };
  // The context the writer checks the brief under (lib/content/generate.ts
  // `assertAutonomousTopic`): the same four facts, so the brief written here
  // is the one it reads back, not a pending verdict it judges again.
  const fingerprint = contextKey({ business, domain: workspace.domain ?? "", languageCode, locationCode: locale.locationCode });
  const fixture = localFixture(domain);

  // --- What the model reads ---------------------------------------------------
  const rows = (keywordRows ?? []) as KeywordRow[];
  const byKey = new Map(rows.map((r) => [topicKey(r.term), r]));
  // A row a person took off the planner, or one already planned or written,
  // is not offered again. A row the buyer test parked is: that test asked
  // only whether a buyer types it, and readers are not only buyers.
  const parked = (r: KeywordRow) => r.status === "stored" && (r.opportunity as { cause?: string } | null)?.cause === "buyer_mismatch";
  const offered = (r: KeywordRow) => (r.status === "new" && !r.plan_excluded_at) || parked(r);
  const positions = await rankedPositions(supabase, rows.filter(offered).map((r) => r.id));
  const pool: PoolTerm[] = rows.filter(offered).map((r) => ({
    term: r.term, volume: r.volume, difficulty: r.difficulty, position: positions.get(r.id) ?? null, ...(parked(r) ? { parked: true } : {}),
  }));
  const pages = ((pageRows ?? []) as Array<{ url: string; path: string | null; title: string | null; h1: string | null }>)
    .map((p) => ({ title: (p.title || p.h1 || "").trim(), path: p.path ?? p.url }))
    .filter((p) => p.title);
  const rivals = [...new Set([...(business?.competitors ?? []), ...(business?.searchRivals ?? [])].map((r) => r.trim().toLowerCase()).filter((r) => /\./.test(r)))].slice(0, RIVALS_READ);
  const rivalPages = fixture ? [] : await timed("rival_pages", () => (opts.rivalPages ?? readRivalPages)(rivals)).catch(() => []);

  // --- 1. Suggest ---------------------------------------------------------------
  let topics: SuggestedTopic[];
  // The first ask came back with no topic: cut off inside its first one, or
  // not at all. The second ask is tried before the run is called ours.
  let firstAskFailed: "provider" | "unreadable" | null = null;
  const ask = opts.ask ?? askStructured;
  if (fixture) {
    topics = fixtureTopics(pool);
  } else {
    if (!opts.ask && !modelAvailable()) return nothing("provider");
    const prompt = suggestTopicsPrompt({
      business: business ?? { name: domain },
      domain,
      language: business?.language || workspace.language || "English",
      pages,
      pool,
      rivalPages,
    });
    summary.modelCalls++;
    let stop: string | null = null;
    const raw = await timed("suggest", () => withStage("judge", () => ask("keyword-research/first-look-topics", prompt, {
      maxTokens: SUGGEST_MAX_TOKENS,
      minTokens: SUGGEST_MIN_TOKENS,
      tier: "decision",
      schema: SUGGEST_SCHEMA,
      cachePrefix: suggestCachePrefix(prompt),
      onStop: (reason) => { stop = reason; },
    })));
    topics = parseSuggestions(extractJson<unknown>(raw, "{", "}") ?? extractJson<unknown>(raw, "[", "]"));
    // A reply cut off at its token limit is not JSON, but the topics it
    // finished are still topics: a run that lost all twenty to the last
    // one's missing brace planned nothing (2026-10-27).
    if (!topics.length && raw) topics = parseSuggestions(salvageTopics(raw));
    if (stop === "max_tokens") console.warn(`[first look] topic suggestions cut off at their token limit; kept ${topics.length}`);
    // An answer that came back and still named no topic is not the
    // provider being down: it is not retried as one, nor described as one.
    if (!topics.length) firstAskFailed = raw ? "unreadable" : "provider";
  }
  summary.suggested = topics.length;
  asked.suggested = topics;

  // --- 2. Score -----------------------------------------------------------------
  const reject = (why: HardReject) => { summary.rejected[why] = (summary.rejected[why] ?? 0) + 1; };
  const taken = new Set(rows.filter((r) => !offered(r)).map((r) => topicKey(r.term)));
  const seen = new Set<string>();
  let candidates: Candidate[] = [];
  /** Topics into the running, minus the ones a hard rule removes before any results page. */
  const admit = (list: readonly SuggestedTopic[], source: Candidate["source"]) => {
    for (const topic of list) {
      if (taken.has(topic.query) || seen.has(topic.query)) continue;
      seen.add(topic.query);
      const why = rejectBeforeResults(topic, { domain, business });
      if (why) { reject(why); continue; }
      const row = byKey.get(topic.query) ?? null;
      candidates.push({ topic, order: seen.size, source, row, volume: row?.volume ?? null, difficulty: row?.difficulty ?? null, score: scoreTopic(topic, { volume: row?.volume ?? null, difficulty: row?.difficulty ?? null, authority: workspace.dr }) });
    }
  };
  admit(topics, "suggested");

  // Volumes for the searches the model added, in one lookup. Best effort: a
  // search the index does not know keeps its neutral demand.
  const unmeasured = candidates.filter((c) => !c.row && !fixture).map((c) => c.topic.query);
  if (unmeasured.length && (opts.metrics || hasDataForSEOCredentials())) {
    try {
      const metrics = await timed("suggest_metrics", () => withStage("discovery", () => (opts.metrics ?? fetchTermMetrics)(unmeasured, locale)));
      candidates = candidates.map((c) => {
        const m = c.row ? null : metrics.get(c.topic.query);
        if (!m) return c;
        return { ...c, volume: m.volume, difficulty: m.difficulty, score: scoreTopic(c.topic, { volume: m.volume, difficulty: m.difficulty, authority: workspace.dr }) };
      });
    } catch (err) {
      console.warn(`[first look] volumes for suggested topics: ${err instanceof Error ? err.message : err}`);
    }
  }

  // --- 3. Read the results pages of the best, while reading can change the pick
  const named = namedBusinesses(business);
  const serpOf = opts.serp ?? ((term: string, at: typeof locale) => fetchAdvancedSerp(term, at, { rich: true }));
  const briefFor = (c: Candidate, how: { rung: FirstLookRung; borrowed?: BorrowedEvidence | null }): Opportunity | null => {
    const chosen: ChosenTopic = { topic: c.topic, score: c.score, volume: c.volume, difficulty: c.difficulty, page: c.page!, organicUrls: c.organicUrls ?? [] };
    return topicBrief(chosen, { fingerprint, domain, conversionUrl: business?.conversionUrl ?? null, now: opts.now, ...how });
  };
  const accepted: Candidate[] = [];
  // Removed as providers' pages, read and scored all the same: the floor's choice.
  const crowded: Candidate[] = [];
  // Kept by every rule, with no article or discussion in its results to cite.
  const uncited: Candidate[] = [];
  // What each page read had to cite: the last floor borrows from a related search.
  const citable: Array<{ query: string; evidence: string[] }> = [];
  // The run's budget refused a results page: nothing more is bought.
  let budgetStopped = false;
  const done = () => summary.resultsRead + summary.resultsFailed;
  const unread = () => candidates.filter((c) => !c.page).sort((a, b) => bestCase(b.score) - bestCase(a.score) || b.score.total - a.score.total || a.order - b.order);
  const settledEnough = () => {
    if (accepted.length < room) return false;
    const floor = [...accepted].sort((a, b) => b.score.total - a.score.total)[room - 1].score.total;
    const next = unread()[0];
    return !next || bestCase(next.score) <= floor;
  };
  const pastDeadline = () => {
    if (opts.firstLook.deadline === undefined || Date.now() < opts.firstLook.deadline) return false;
    opts.firstLook.timedOut = true;
    summary.stopped ??= "deadline";
    return true;
  };
  const readOne = async (c: Candidate, pastCap: boolean) => {
    const key = c.topic.query;
    let serp = opts.firstLook.serps?.get(key);
    if (!serp) {
      try {
        serp = fixture ? fixtureSerp(key) : await timed("results_pages", () => withStage("results_pages", () => serpOf(key, locale)));
        opts.firstLook.serps?.set(key, serp);
      } catch (err) {
        // The budget's refusal is not a page that failed: the topic stays
        // unread, and can still be proposed.
        if (isBudgetRefusal(err)) { budgetStopped = true; summary.stopped = "budget"; return; }
        summary.resultsFailed++;
        console.warn(`[first look] results page for a topic: ${err instanceof Error ? err.message : err}`);
        // Out of the running: a page nobody could read is no evidence.
        candidates = candidates.filter((x) => x !== c);
        return;
      }
    }
    summary.resultsRead++;
    if (pastCap && c.source === "suggested") summary.extendedReads = (summary.extendedReads ?? 0) + 1;
    const organic = judgedResults(serp.organic);
    const reading = readResultsPage(organic, { term: key, named, domain });
    const why = rejectOnResults(reading, { question: asksQuestion(key, languageCode) });
    c.page = { reading, ...(existingPageIn(organic, c.row?.source_url, domain) ? { ownUrl: existingPageIn(organic, c.row?.source_url, domain) } : {}) };
    c.organicUrls = organic.map((r) => r.url);
    c.score = scoreTopic(c.topic, { volume: c.volume, difficulty: c.difficulty, authority: workspace.dr, page: c.page });
    // Not from a page one site owns or one that is about something else.
    const evidence = why === "navigational" || why === "offtopic" ? [] : evidenceOf(reading).filter((url) => c.organicUrls!.includes(url));
    if (evidence.length) citable.push({ query: key, evidence });
    const record = (verdict: FirstLookRead["verdict"]) => reads.push({
      query: key, source: c.source, type: reading.type, ...(reading.why ? { why: reading.why } : {}), verdict,
      results: organic.map((r, i) => ({ rank: r.rank ?? i + 1, url: r.url, title: (r.title ?? "").slice(0, 200), description: (r.description ?? "").slice(0, 200), domain: r.domain ?? "", kind: reading.results[i]?.kind ?? "other", page: reading.results[i]?.page ?? "offtopic" })),
    });
    candidates = candidates.filter((x) => x !== c);
    if (why) {
      reject(why);
      if (why === "needs_page") crowded.push(c);
      record(why);
      return;
    }
    const rung: FirstLookRung = c.source === "second_ask" ? "second_ask" : pastCap ? "extended" : "ranked";
    const brief = briefFor(c, { rung });
    if (!brief) { summary.noEvidence++; uncited.push(c); record("no_evidence"); return; }
    c.brief = brief;
    c.rung = rung;
    accepted.push(c);
    record("accepted");
  };
  /**
   * Read the best unread candidates, a round at a time, up to `cap` pages.
   * The cap holds once something is accepted. While nothing is, reading goes
   * on past it: a site whose first twelve pages were all providers' pages
   * used to stop there with eight suggestions unread and plan nothing. What
   * ends it then is a topic accepted, the suggestions running out, the
   * budget refusing a page, or the deadline.
   */
  const readPages = async (cap: number) => {
    while (!settledEnough() && !budgetStopped && done() < HARD_MAX_READS) {
      const pastCap = done() >= cap;
      if (pastCap && accepted.length) break;
      if (pastDeadline()) break;
      const round = unread().slice(0, pastCap ? RESULTS_ROUND : Math.min(RESULTS_ROUND, cap - done()));
      if (!round.length) break;
      opts.onProgress?.({ checking: round.map((c) => c.topic.query), judged: summary.resultsRead, qualified: accepted.length });
      await Promise.all(round.map((c) => readOne(c, pastCap)));
    }
  };
  await readPages(MAX_RESULTS_READS);

  // --- The second ask: question searches from the profile ----------------------
  //
  // Every suggested search was read (or the first ask named none) and nothing
  // can be planned. One more model call turns the profile's jobs, offerings
  // and readers into searches that are questions by their words, read through
  // the same path. Not when the results provider answered nothing at all, the
  // budget has refused a page, or too little time is left for the call.
  const timeLeft = (ms: number) => opts.firstLook.deadline === undefined || opts.firstLook.deadline - Date.now() > ms;
  const resultsAnswer = summary.resultsRead > 0 || summary.resultsFailed === 0;
  if (!accepted.length && !fixture && !budgetStopped && unread().length === 0 && resultsAnswer && timeLeft(SECOND_ASK_MIN_MS) && (opts.ask || modelAvailable())) {
    const prompt = secondAskPrompt({
      business: business ?? { name: domain },
      domain,
      language: business?.language || workspace.language || "English",
      tried: [...seen],
    });
    summary.modelCalls++;
    const raw = await timed("suggest", () => withStage("judge", () => ask("keyword-research/first-look-second-ask", prompt, {
      maxTokens: SECOND_ASK_MAX_TOKENS,
      minTokens: SECOND_ASK_MIN_TOKENS,
      tier: "decision",
      schema: SUGGEST_SCHEMA,
      cachePrefix: suggestCachePrefix(prompt),
    }))).catch((err: unknown) => {
      console.warn(`[first look] second ask: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    let more = parseSuggestions(extractJson<unknown>(raw, "{", "}") ?? extractJson<unknown>(raw, "[", "]"));
    if (!more.length && raw) more = parseSuggestions(salvageTopics(raw));
    more = more.slice(0, SECOND_ASK_TOPICS);
    asked.secondAsk = more;
    const before = summary.resultsRead;
    summary.secondAsk = { suggested: more.length, read: 0 };
    admit(more, "second_ask");
    await readPages(done() + SECOND_ASK_TOPICS);
    summary.secondAsk.read = summary.resultsRead - before;
  }
  // Neither ask named a topic: ours, as the first ask's failure was.
  if (firstAskFailed && !seen.size) return nothing(firstAskFailed);

  // --- The floors ---------------------------------------------------------------
  //
  // Nothing passed the bar. Of what was read, searches whose words ask a
  // question lead (an article is what answers them), then the score.
  //
  // The best of them with something to cite is planned, at lower confidence
  // and said so: an article or a discussion in its own results (the floor
  // of 2026-11-16), or, for a search with none, the articles that rank for
  // a closely related search read in this run (`relatedEvidence`).
  const floorPool = [...crowded, ...uncited].sort((a, b) =>
    Number(asksQuestion(b.topic.query, languageCode)) - Number(asksQuestion(a.topic.query, languageCode)) || b.score.total - a.score.total || a.order - b.order);
  if (!accepted.length) {
    for (const c of floorPool) {
      if (accepted.length >= room) break;
      let rung: FirstLookRung = "floor";
      let brief = briefFor(c, { rung });
      if (!brief) {
        rung = "related_evidence";
        const borrowed = relatedEvidence(c.topic.query, citable);
        brief = borrowed ? briefFor(c, { rung, borrowed }) : null;
      }
      if (!brief) continue;
      c.brief = brief;
      c.rung = rung;
      accepted.push(c);
    }
    // The last rung. Nothing read has anything to cite, here or on a related
    // search: the best of what was read is planned all the same, citing
    // nothing. Three signups whose every search was won by providers' own
    // pages ended with no article twice (2026-11-16 and the rerun of
    // 2026-11-25), on sites we knew the business of. One article, never a
    // list of them.
    if (!accepted.length && floorPool.length) {
      const c = floorPool[0];
      c.brief = uncitedBrief({ topic: c.topic, score: c.score, volume: c.volume, difficulty: c.difficulty, page: c.page!, organicUrls: c.organicUrls ?? [] }, { fingerprint, domain, conversionUrl: business?.conversionUrl ?? null, now: opts.now });
      c.rung = "uncited";
      accepted.push(c);
    }
    if (accepted.length) summary.floor = true;
  }

  // Each floor sorted its own way; the bar's picks by score.
  if (!summary.floor) accepted.sort((a, b) => b.score.total - a.score.total || a.order - b.order);
  if (!accepted.length) {
    // The results provider answered none of the pages, or the deadline came
    // before one was read: ours, and the overnight retry's to try again.
    if (summary.resultsRead === 0 && !budgetStopped && (summary.resultsFailed > 0 || opts.firstLook.timedOut)) return nothing("provider");
    // No results page was read that a hard rule left standing (the budget
    // refused them, or the deadline came first): the best unread search is
    // proposed to the owner, whose "write this" is the confirmation the
    // writer's check is missing (`ownerConfirmedBrief`).
    const best = unread()[0];
    if (best) {
      summary.proposed = true;
      return { ...nothing("needs_owner_input"), proposal: proposalOf({ topic: best.topic, score: best.score, volume: best.volume, difficulty: best.difficulty, page: best.page, organicUrls: best.organicUrls ?? [] }) };
    }
    // Every suggestion named a business, looked for one site or was off topic.
    return nothing("none");
  }

  // --- 4. Pick, and write it down --------------------------------------------
  //
  // Every write is bounded by the plan's deadline: a save that never answered
  // held a production first look for 25 minutes (2026-10-15). A topic whose
  // save does not land gives its place to the next one.
  const within = <T>(work: PromiseLike<T>, what: string): Promise<T> => {
    const left = Math.max(SAVE_FLOOR_MS, (opts.firstLook.deadline ?? Date.now() + SAVE_FLOOR_MS) - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer`)), left); }),
    ]).finally(() => clearTimeout(timer));
  };
  const intentOf = (term: string) => classifyIntent(term, workspace.language ?? "en").intent;
  const save = async (c: Candidate): Promise<string> => {
    if (c.row) {
      const { error } = await within(supabase
        .from("keywords")
        .update({ opportunity: c.brief, status: "new", plan_excluded_at: null, ...(c.row.volume === null && c.volume !== null ? { volume: c.volume } : {}), ...(c.row.difficulty === null && c.difficulty !== null ? { difficulty: c.difficulty } : {}) })
        .eq("id", c.row.id)
        .eq("workspace_id", workspaceId), "Saving the first look's topic");
      if (error) throw new Error(`Could not save the first look's topic: ${error.message}`);
      return c.row.id;
    }
    const { data, error } = await within(supabase
      .from("keywords")
      .insert({
        workspace_id: workspaceId, term: c.topic.query, volume: c.volume, difficulty: c.difficulty, cpc: null,
        intent: intentOf(c.topic.query), status: "new", source: "ideas", source_type: "profile", source_ref: c.topic.reader.slice(0, 200) || null,
        opportunity: c.brief,
      })
      .select("id")
      .single(), "Saving the first look's topic");
    if (error || !data) throw new Error(`Could not save the first look's topic: ${error?.message ?? "no row"}`);
    return data.id as string;
  };
  const picks: Array<Candidate & { id: string }> = [];
  let next = 0;
  let lastError: unknown = null;
  for (; next < accepted.length && picks.length < room; next++) {
    try { picks.push({ ...accepted[next], id: await save(accepted[next]) }); } catch (err) { lastError = err; console.warn(`[first look] ${err instanceof Error ? err.message : err}`); }
  }
  if (!picks.length) throw lastError instanceof Error ? lastError : new Error("Could not save the first look's topic.");
  // Kept with a brief and not planned: what the trial opens (./plan.ts
  // `heldTopics`), and what the nightly top-up plans next. Best effort.
  for (const c of accepted.slice(next)) {
    try { await save(c); summary.ready++; } catch (err) { console.warn(`[first look] ${err instanceof Error ? err.message : err}`); }
  }

  await within(supabase.from("calendar_entries").delete().eq("workspace_id", workspaceId).eq("status", "queue").is("article_id", null), "Clearing the calendar's queue");
  const dates = nextOpenDates(kept.map((e) => e.scheduled_date), Math.max(1, opts.weeklyLimit), picks.length, opts.now ?? new Date());
  const plan: PlannedEntry[] = picks.slice(0, dates.length).map((c, i) => ({ keywordId: c.id, term: c.topic.query, date: dates[i], brief: c.brief }));
  if (!plan.length) return nothing("full");
  const { error: calError } = await within(supabase.from("calendar_entries").insert(plan.map((p) => ({
    workspace_id: workspaceId, keyword_id: p.keywordId, keyword: p.term, scheduled_date: p.date, status: "queue",
  }))), "Writing the calendar");
  if (calError) throw new Error(calError.message);
  await within(supabase.from("keywords").update({ status: "planned" }).eq("workspace_id", workspaceId).eq("status", "new").in("id", plan.map((p) => p.keywordId)), "Marking the topics planned");
  try {
    if (opts.decorate !== false) await (opts.decorate ?? decoratePlannedKeywords)(supabase, workspaceId, plan.map((p) => p.keywordId), new Map(), opts.questionsInBackground);
  } catch (err) {
    console.warn("[first look] could not decorate planned keywords:", err instanceof Error ? err.message : err);
  }

  for (const c of picks.slice(0, plan.length)) {
    selection.set(c.topic.query, {
      reasons: selectionReasons({ topic: c.topic, score: c.score, volume: c.volume, page: c.page! }),
      score: c.score.total,
      volume: c.volume,
      difficulty: c.difficulty,
    });
  }
  const first = picks[0];
  summary.planned = plan.length;
  summary.rung = first.rung ?? "ranked";
  summary.chosen = { term: first.topic.query, score: first.score, volume: first.volume, line: describeScore(first.score, first.volume) };
  // No term: the keyword row carries the score with it (`firstLookScore`).
  console.log(`[first look] ${workspaceId}: chose a topic at ${summary.chosen.line}; ${summary.suggested} suggested, ${Object.entries(summary.rejected).map(([k, n]) => `${n} ${HARD_REJECT_WORDS[k as HardReject]}`).join(", ") || "none removed"}, ${summary.resultsRead} results pages read, planned on the ${summary.rung} rung`);
  return { plan, outcome: "planned", summary, selection, reads, asked };
}

/** Where the site already ranks, by keyword row. */
async function rankedPositions(supabase: SupabaseClient, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const { data } = await supabase.from("keyword_rankings").select("keyword_id, position").in("keyword_id", ids.slice(0, 500));
  for (const r of (data ?? []) as Array<{ keyword_id: string; position: number | null }>) {
    if (typeof r.position === "number" && (!out.has(r.keyword_id) || r.position < out.get(r.keyword_id)!)) out.set(r.keyword_id, r.position);
  }
  return out;
}

/**
 * What the rivals publish, from their sitemaps: post slugs as words. Plain
 * GETs, a few per rival, bounded in time; a rival that does not answer is
 * simply not read.
 */
export async function readRivalPages(rivals: string[]): Promise<Array<{ rival: string; pages: string[] }>> {
  const deadline = Date.now() + RIVAL_READ_MS;
  const read = await Promise.all(rivals.map(async (rival) => {
    try {
      const { urls } = await readSiteUrls(rival, { maxUrls: 400, maxChildren: 3, timeoutMs: 4_000, deadline, fallback: false });
      const posts = urls.filter((u) => looksLikePost(u.url, { fromPostList: u.fromPostList }));
      const pages = [...new Set((posts.length ? posts : urls).map((u) => slugWords(u.url)).filter((w) => w.split(" ").length >= 3))];
      return { rival, pages: pages.slice(0, 25) };
    } catch {
      return { rival, pages: [] };
    }
  }));
  return read.filter((r) => r.pages.length);
}

function slugWords(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last).replace(/\.[a-z]{2,5}$/i, "").replace(/[-_]+/g, " ").replace(/\b\d{4,}\b/g, "").trim().toLowerCase();
  } catch {
    return "";
  }
}

// --- The end-to-end suite's fixtures (lib/e2e/stubs.ts) ------------------------
//
// The browser suite replaces the paid edges and still exercises the plan and
// its writes. Restricted, as qualification's fixture was, to a reserved
// domain AND a loopback database, whatever E2E_STUBS says.

function localFixture(domain: string): boolean {
  return e2eStubsEnabled() && isReservedTestDomain(domain) &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
}

function fixtureTopics(pool: readonly PoolTerm[]): SuggestedTopic[] {
  return pool.slice(0, 20).map((p) => ({
    query: topicKey(p.term), fromList: true, reader: "Fixture reader", job: p.term, offering: "Fixture offering",
    angle: `A guide to ${p.term}`.slice(0, 90), shape: "explainer", fit: 4, kind: "question", why: "E2E fixture: a topic the fixture readers ask.",
  }));
}

function fixtureSerp(term: string): SerpData {
  const slug = encodeURIComponent(term.replace(/\s+/g, "-"));
  return {
    organic: [1, 2, 3].map((n) => ({ rank: n, title: `How to ${term}: a guide`, url: `https://source-${n}.example/blog/${slug}`, description: `A guide to ${term}.`, domain: `source-${n}.example`, wordCount: 1200 })),
    peopleAlsoAsk: [],
    aiOverview: null,
  };
}
