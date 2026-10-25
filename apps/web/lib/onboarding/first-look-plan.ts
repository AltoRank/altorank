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

import type { SupabaseClient } from "@supabase/supabase-js";
import { PRE_TRIAL_DRAFTS, planHold } from "@/lib/billing/trial-hold";
import { withStage } from "@/lib/billing/spend-scope";
import { e2eStubsEnabled, isReservedTestDomain } from "@/lib/e2e/stubs";
import { askStructured, extractJson, modelAvailable, type AskModel } from "@/lib/keyword-research/buyer-model";
import type { FitProfile } from "@/lib/keyword-research/buyer-fit";
import {
  bestCase,
  describeScore,
  HARD_REJECT_WORDS,
  namedBusinesses,
  parseSuggestions,
  rejectBeforeResults,
  rejectOnResults,
  scoreTopic,
  selectionReasons,
  SUGGEST_MAX_TOKENS,
  SUGGEST_MIN_TOKENS,
  SUGGEST_SCHEMA,
  suggestCachePrefix,
  suggestTopicsPrompt,
  topicBrief,
  topicKey,
  type ChosenTopic,
  type HardReject,
  type PageRead,
  type PoolTerm,
  type SuggestedTopic,
  type TopicScore,
} from "@/lib/keyword-research/first-look-topics";
import { languageCodeOf } from "@/lib/keyword-research/locale";
import { fetchTermMetrics } from "@/lib/keyword-research/metrics";
import { contextKey, existingPageIn, judgedResults, type FirstLook, type Opportunity } from "@/lib/keyword-research/opportunity";
import { readResultsPage } from "@/lib/keyword-research/results-page";
import { fetchAdvancedSerp, type SerpData } from "@/lib/seo/brief-data";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { classifyIntent } from "@/lib/seo/intent";
import { looksLikePost, readSiteUrls } from "@/lib/seo/site-urls";
import { decoratePlannedKeywords, type PlannedEntry } from "./plan";
import { nextOpenDates, PLAN_MAX_ENTRIES } from "./plan-limits";
import { timed } from "./timings";

/** Results pages read side by side. */
export const RESULTS_ROUND = 4;
/** Results pages a first look reads at most. */
export const MAX_RESULTS_READS = 12;
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
  /** Every candidate read was removed by a hard rule. */
  | "none";

export interface FirstLookPlanResult {
  plan: PlannedEntry[];
  outcome: FirstLookOutcome;
  summary: FirstLookSummary;
  /** Per planned term: what the article records as why it was chosen. */
  selection: Map<string, { reasons: string[]; score: number; volume: number | null; difficulty: number | null }>;
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
  const nothing = (outcome: FirstLookOutcome): FirstLookPlanResult => ({ plan: [], outcome, summary, selection });

  // The trial hold decides how many (lib/billing/trial-hold.ts), as it does
  // for every planner: one article before the trial, nothing once it is spent.
  const hold = await planHold(supabase, workspaceId);
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
    const ask = opts.ask ?? askStructured;
    summary.modelCalls++;
    const raw = await timed("suggest", () => withStage("judge", () => ask("keyword-research/first-look-topics", prompt, {
      maxTokens: SUGGEST_MAX_TOKENS,
      minTokens: SUGGEST_MIN_TOKENS,
      tier: "decision",
      schema: SUGGEST_SCHEMA,
      cachePrefix: suggestCachePrefix(prompt),
    })));
    topics = parseSuggestions(extractJson<unknown>(raw, "{", "}") ?? extractJson<unknown>(raw, "[", "]"));
  }
  summary.suggested = topics.length;
  if (!topics.length) return nothing("provider");

  // --- 2. Score -----------------------------------------------------------------
  const reject = (why: HardReject) => { summary.rejected[why] = (summary.rejected[why] ?? 0) + 1; };
  const taken = new Set(rows.filter((r) => !offered(r)).map((r) => topicKey(r.term)));
  let candidates: Candidate[] = [];
  for (const topic of topics) {
    if (taken.has(topic.query)) continue;
    const why = rejectBeforeResults(topic, { domain, business });
    if (why) { reject(why); continue; }
    const row = byKey.get(topic.query) ?? null;
    candidates.push({ topic, row, volume: row?.volume ?? null, difficulty: row?.difficulty ?? null, score: scoreTopic(topic, { volume: row?.volume ?? null, difficulty: row?.difficulty ?? null, authority: workspace.dr }) });
  }

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
  const accepted: Candidate[] = [];
  const unread = () => candidates.filter((c) => !c.page).sort((a, b) => bestCase(b.score) - bestCase(a.score) || b.score.total - a.score.total || a.topic.query.localeCompare(b.topic.query));
  const settledEnough = () => {
    if (accepted.length < room) return false;
    const floor = [...accepted].sort((a, b) => b.score.total - a.score.total)[room - 1].score.total;
    const next = unread()[0];
    return !next || bestCase(next.score) <= floor;
  };
  while (summary.resultsRead + summary.resultsFailed < MAX_RESULTS_READS && !settledEnough()) {
    if (opts.firstLook.deadline !== undefined && Date.now() >= opts.firstLook.deadline) { opts.firstLook.timedOut = true; break; }
    const round = unread().slice(0, Math.min(RESULTS_ROUND, MAX_RESULTS_READS - summary.resultsRead - summary.resultsFailed));
    if (!round.length) break;
    opts.onProgress?.({ checking: round.map((c) => c.topic.query), judged: summary.resultsRead, qualified: accepted.length });
    await Promise.all(round.map(async (c) => {
      const key = c.topic.query;
      let serp = opts.firstLook.serps?.get(key);
      if (!serp) {
        try {
          serp = fixture ? fixtureSerp(key) : await timed("results_pages", () => withStage("results_pages", () => serpOf(key, locale)));
          opts.firstLook.serps?.set(key, serp);
        } catch (err) {
          summary.resultsFailed++;
          console.warn(`[first look] results page for a topic: ${err instanceof Error ? err.message : err}`);
          // Out of the running: a page nobody could read is no evidence.
          candidates = candidates.filter((x) => x !== c);
          return;
        }
      }
      summary.resultsRead++;
      const organic = judgedResults(serp.organic);
      const reading = readResultsPage(organic, { term: key, named, domain });
      const why = rejectOnResults(reading);
      if (why) { reject(why); candidates = candidates.filter((x) => x !== c); return; }
      c.page = { reading, ...(existingPageIn(organic, c.row?.source_url, domain) ? { ownUrl: existingPageIn(organic, c.row?.source_url, domain) } : {}) };
      c.organicUrls = organic.map((r) => r.url);
      c.score = scoreTopic(c.topic, { volume: c.volume, difficulty: c.difficulty, authority: workspace.dr, page: c.page });
      const chosen: ChosenTopic = { topic: c.topic, score: c.score, volume: c.volume, difficulty: c.difficulty, page: c.page, organicUrls: c.organicUrls };
      const brief = topicBrief(chosen, { fingerprint, domain, conversionUrl: business?.conversionUrl ?? null, now: opts.now });
      if (!brief) { summary.noEvidence++; candidates = candidates.filter((x) => x !== c); return; }
      c.brief = brief;
      accepted.push(c);
    }));
  }

  accepted.sort((a, b) => b.score.total - a.score.total || a.topic.query.localeCompare(b.topic.query));
  if (!accepted.length) {
    // Nothing read could be cited. When the provider answered none of the
    // pages, that is ours; otherwise every candidate read was one of the
    // four things an article is never planned for.
    return nothing(summary.resultsRead === 0 && (summary.resultsFailed > 0 || opts.firstLook.timedOut) ? "provider" : "none");
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
    await decoratePlannedKeywords(supabase, workspaceId, plan.map((p) => p.keywordId), new Map(), opts.questionsInBackground);
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
  summary.chosen = { term: first.topic.query, score: first.score, volume: first.volume, line: describeScore(first.score, first.volume) };
  // No term: the keyword row carries the score with it (`firstLookScore`).
  console.log(`[first look] ${workspaceId}: chose a topic at ${summary.chosen.line}; ${summary.suggested} suggested, ${Object.entries(summary.rejected).map(([k, n]) => `${n} ${HARD_REJECT_WORDS[k as HardReject]}`).join(", ") || "none removed"}, ${summary.resultsRead} results pages read`);
  return { plan, outcome: "planned", summary, selection };
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
