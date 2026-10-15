// ---------------------------------------------------------------------------
// Onboarding, run start to finish, reporting as it goes
// ---------------------------------------------------------------------------
//
// The three things a new site needs before its dashboard means anything: a
// voice profile so drafts sound like it, a keyword set so there is something to
// write about, and a first draft so the review queue is not empty. This runs
// them in that order and calls `emit` at each boundary, which is what turns a
// silent 90-second wait into a screen that shows the work.
//
// Where the draft is written depends on the caller. The onboarding worker
// (/api/onboard/run) asks for `firstDraft: "dispatch"`: this picks the keyword
// and the gates it here, then returns it as `pendingDraft` for the worker to
// hand to /api/internal/draft in its own invocation - a draft is 100-280s on
// its own, and the worker's budget is the same 300s, so writing it here would
// put the worker back at the ceiling the SSE route used to hit. The draft
// route stamps the run when it lands. `"inline"` (the default) awaits it here,
// which is what a caller with no way to self-invoke gets - the google-properties
// import, and a self-hosted install with no CRON_SECRET - and what the whole
// run did until 2026-09-07. Before that it ran in an after() callback from a
// server action, which serverless killed once the response was sent; measured
// 2026-09-03: first drafts landed 5-19h after signup, from the nightly cron.
//
// Every phase persists as it completes - trainVoiceProfile writes the profile,
// analyseDomain writes keywords and metrics, generateArticle writes the
// article and its job - so a run cut short leaves real, partial state rather
// than nothing, and the dashboard shows whatever got done.

import type { RankedKeyword } from "@/lib/seo/ranked-keywords";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSiteText } from "./site-text";
import { checkDomainReachable } from "@/lib/domain/reachable";
import { trainVoiceProfile } from "@/lib/voice/train";
import { composeVoiceSample, readExampleArticles, readExampleUrls } from "@/lib/voice/examples";
import { analyseDomain, isTransientCrawlFailure } from "@/lib/audit/domain-analysis";
import { refusing } from "@/lib/audit/host-circuit";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { generateArticle } from "@/lib/content/generate";
import { draftHoldReason, planHold } from "@/lib/billing/trial-hold";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { seedKeywordsFromSearchConsole } from "@/lib/gsc/seed";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { spendClient } from "@/lib/billing/default-spend";
import { currentSpendScope, isBudgetRefusal, watchRefusals, withSpendScope, withStage } from "@/lib/billing/spend-scope";
import { draftBudgetShort, draftCanBuyLookup, firstLookCeiling, firstLookResearchLeave, leavingRoom, openFirstLookBudget, type RunBudgetState } from "@/lib/billing/run-budget";
import type { EmptyPool, OnboardingArticle, OnboardingEvent, PhaseStatus } from "./events";
import { readEmptyPool } from "./empty-pool";
import { modelAvailable } from "@/lib/keyword-research/buyer-model";
import { countScheduled, heldTopics, schedulePlan, fulfilPlannedEntry, type PlannedEntry } from "./plan";
import { recordPlanFunnel } from "./funnel-event";
import { withScreened, type TopicFunnel } from "@/lib/keyword-research/topic-funnel";
import type { FirstLook } from "@/lib/keyword-research/opportunity";
import { timed, withRunClock, type RunClock } from "./timings";

/** Pages the onboarding minute reads. The nightly pass reads up to forty. */
const ONBOARDING_CRAWL_PAGES = 20;
import { fetchRelatedKeywordsBatch, type RelatedKeyword, type SerpData } from "@/lib/seo/brief-data";
import { getLocale } from "@/lib/seo/locales";
import { detectLinks } from "@/lib/linking/detect";
import { assessExistingPages } from "./site-assessment";
import { FREE_TIER_PACE } from "@/lib/content/pace";

export type Emit = (event: OnboardingEvent) => void;

export interface RunOnboardingOptions {
  /** See the header: `inline` awaits the draft here, `dispatch` returns it. */
  firstDraft?: "inline" | "dispatch";
  /** The `onboarding_runs` row, named on the run's funnel event (./funnel-event.ts). */
  runId?: string;
  /**
   * The run's stopwatch (./timings.ts): every stage below reports to it, and
   * the funnel event carries what it measured. The worker owns it and
   * writes it to the row.
   */
  clock?: RunClock;
}

/** The first draft, chosen and gated but not yet written, for the caller to dispatch. */
export interface PendingDraft {
  term: string;
  keywordId: string | null;
  selection: { reasons: string[]; score: number; difficulty: number | null; volume: number | null };
  /** This draft's share of the run's one related-keyword lookup, when it ran. */
  relatedKeywords?: RelatedKeyword[];
  /** The results page this run bought for the term when it judged it, for the draft's research. */
  serp?: SerpData;
}

export interface RunOnboardingResult {
  /** Set only under `firstDraft: "dispatch"`, and only when there is a draft to write. */
  pendingDraft: PendingDraft | null;
  /**
   * Settles when the fan-out's requests have all answered. A serverless
   * caller hands it to `after()` so the instance outlives its own response
   * long enough for the requests to leave; nothing waits on it otherwise.
   */
  fanOutSettled: Promise<void>;
  /**
   * Work the run started and does not wait for - the speed test, whose
   * result lands on the audit when it answers. A serverless caller keeps the
   * instance alive for it with `after()`; no email or status waits on it.
   */
  tailSettled?: Promise<void>;
}

interface Workspace {
  id: string;
  domain: string | null;
  account_id: string;
  language: string | null;
  location_code?: number | null;
  auto_generate_weekly_limit?: number | null;
  /** Optional: the caller may not have selected it. Absent means seed from headings alone. */
  business_profile?: unknown;
}

/**
 * Run the pipeline for a workspace, emitting an event at every boundary.
 *
 * Never throws for an expected outcome - a site with no readable text, a
 * missing API key, an exhausted quota - because those are `skipped` events the
 * screen should show, not errors that abort the run. A genuinely unexpected
 * failure in one phase is caught, emitted as that phase failing, and the run
 * continues to the next: a keyword search that breaks should not cost the
 * account its voice profile.
 */
export async function runOnboarding(
  supabase: SupabaseClient,
  workspace: Workspace,
  emit: Emit,
  options: RunOnboardingOptions = {},
): Promise<RunOnboardingResult> {
  // Every provider call this run makes belongs to this workspace and this
  // run, and the run has a dollar (lib/billing/run-budget.ts). Both travel in
  // a spend scope (lib/billing/spend-scope.ts), not in a process-global
  // reporter: that one was armed over by whatever else the process ran, and
  // concurrent runs billed each other's calls (2026-09-28). Every paid call
  // inside claims its estimate from the budget first; a refused claim buys
  // nothing, and the phase that asked carries on with what it has. Spend and
  // the budget are written with the service role: provider_spend refuses a
  // signed-in client's inserts, and run_budgets is server only.
  // A run whose budget row cannot be written is bounded in this process
  // instead (openFirstLookBudget), never left unbounded.
  const runId = options.runId ?? null;
  const db = spendClient() ?? supabase;
  const opened = runId ? await openFirstLookBudget(db, { runId, workspaceId: workspace.id }) : null;
  const clock = options.clock;
  const run = () => withSpendScope({ workspaceId: workspace.id, runId, budget: opened?.budget ?? null }, () =>
    runPhases(supabase, workspace, emit, options.firstDraft ?? "inline", runId, opened?.read ?? null, clock ?? null),
  );
  return clock ? withRunClock(clock, run) : run();
}

async function runPhases(
  supabase: SupabaseClient,
  workspace: Workspace,
  emit: Emit,
  firstDraft: "inline" | "dispatch",
  runId: string | null = null,
  /** The run's budget as it stands, for the funnel event; null when it has none. */
  readSpend: (() => Promise<RunBudgetState | null>) | null = null,
  clock: RunClock | null = null,
): Promise<RunOnboardingResult> {
  const domain = workspace.domain;
  // Approvals asked twice and the floor allowed; the spend bound is the
  // scope's budget, which every paid call claims from.
  const firstLook: FirstLook = { runId, serps: new Map() };

  // --- Phase 0: is there a site here at all? -------------------------------
  //
  // Every phase below gates on `!domain` and on nothing else, so until this
  // check a domain that resolves to nothing still produced keywords, a page
  // check, a planned month and a first draft - each one rendered as a green
  // tick. A run reported "read 42 pages" of a site that does not exist.
  //
  // `no-dns` is the only verdict that stops the run, because it is the only
  // one that is certain: there is no host. A site behind a WAF that refuses
  // our fetch still gets its full run (lib/domain/reachable.ts explains why).
  if (domain) {
    const reach = await timed("reach", () => checkDomainReachable(domain));
    if (reach.verdict === "no-dns" || reach.verdict === "invalid") {
      emit({ phase: "scanning", status: "failed", detail: reach.reason });
      for (const phase of ["keywords", "pages", "planning", "drafting"] as const) {
        emit({ phase, status: "skipped", detail: "There is no site at this domain to work from." });
      }
      return { pendingDraft: null, fanOutSettled: Promise.resolve(), tailSettled: Promise.resolve() };
    }
  }

  // --- Phase 1: read the site, learn its voice ----------------------------
  //
  // Whether this phase finds readable text decides what the rest of the run
  // can do, and it used to decide nothing at all: example.com was told
  // "Skipped reading your site - too little readable text on the site to
  // learn from" and then given 100 keywords, a 30-day calendar and seven
  // written drafts, for $1.63 (R4-4-blank-flow.md, B1). Two filters should
  // have caught it and both were bypassed precisely because there was no
  // profile. That is fixed where it belongs, in `analyseDomain`: with no
  // usable profile it stores no keywords and says so on its keywords layer,
  // `keywordsFound` stays 0, and phases 4 and 5 below already know what to do
  // with that - skip, and say why. Phase 0 stops the adjacent case, a domain
  // with no DNS at all.
  //
  // Side by side with the keyword phase below: the voice is read by the
  // writer and by nothing the keyword work does, and the two used to run one
  // after the other - twenty-two seconds of a production first look's
  // critical path (2026-10-09) before any keyword work began. Awaited before
  // the plan, so its outcome is on the row before anything reads it.
  emit({ phase: "scanning", status: "active" });
  const scanning = (async () => {
  if (!domain) {
    emit({ phase: "scanning", status: "skipped", detail: "No domain on this workspace yet." });
  } else {
    try {
      // Same reader as the wizard: homepage, then the blog when the homepage
      // is a JavaScript shell, then a rendered fetch. A voice learned from the
      // site's own articles is better than one learned from its landing page.
      // The articles the person chose as their best writing go first in the
      // sample (lib/voice/examples.ts). Read alongside the site, never in
      // the way of it: a failure here only means the site text stands alone.
      const [read, chosen] = await Promise.all([
        timed("site_read", () => withStage("voice", () => readSiteText(domain))),
        readExampleUrls(supabase, workspace.id).then((urls) => readExampleArticles(urls)).catch(() => ""),
      ]);
      const text = composeVoiceSample(chosen, read.text);
      if (text && text.split(/\s+/).length > 50) {
        await timed("voice", () => withStage("voice", () => trainVoiceProfile(supabase, workspace.id, text)));
        emit({
          phase: "scanning",
          status: "done",
          detail: chosen
            ? "Learned how your site writes, starting from the articles you chose."
            : read.source === "sitemap" ? "Learned how your site writes, from its articles." : "Learned how your site writes.",
        });
      } else {
        // Phrased so it still reads correctly when `onboardingOutcome` quotes
        // it as the root cause of a later phase - which it does, since scanning
        // is first in PHASE_ORDER. "…to learn a voice" produced "nothing could
        // be scheduled yet: too little readable text on the site to learn a
        // voice", which blames scheduling on voice training. What actually
        // stopped both is the site.
        emit({ phase: "scanning", status: "skipped", detail: "Too little readable text on the site to learn from." });
      }
    } catch (err) {
      emit({ phase: "scanning", status: "failed", detail: message(err) });
    }
  }
  })();

  // --- Phase 3, started early: read the pages they already have ------------
  //
  // Started the moment the keyword phase has read the site and its rankings
  // (`onRead`), and run beside the buyer test, which is the long part of the
  // keyword phase and needs none of it. It used to wait for the whole keyword
  // phase. The plan still waits for it: the recommender reads the pages the
  // site already has, so a topic one of them covers is not planned again.
  let pagesStarted: Promise<void> | null = null;
  const startPages = (ranked?: RankedKeyword[]) => {
    if (pagesStarted || !domain) return pagesStarted;
    pagesStarted = readExistingPages(supabase, workspace.id, domain, emit, ranked);
    return pagesStarted;
  };

  // --- Phase 2: find what to write about ----------------------------------
  emit({ phase: "keywords", status: "active" });
  let keywordsFound = 0;
  // Research ran, read the site, and found nothing: an empty pool, not a
  // failure. False for every reason the research could not look (no domain,
  // no provider, a crawl that failed, a keyword layer that was unavailable).
  let researchFoundNothing = false;
  // What discovery's hygiene dropped before storing anything, for the funnel.
  let screened: { generalRival: number; offProfile: number } | undefined;
  // The deferred speed test, kept alive with the rest of the run's tail.
  let speedSettled: Promise<void> = Promise.resolve();
  // The planned topics' owner questions, written after the plan returns.
  let questionsSettled: Promise<void> = Promise.resolve();
  if (!domain) {
    emit({ phase: "keywords", status: "skipped", detail: "No domain to analyse." });
  } else if (!hasDataForSEOCredentials()) {
    emit({ phase: "keywords", status: "skipped", detail: "Keyword research is not configured on this install." });
  } else {
    try {
      // Watched for the budget's refusals: a buyer test the budget stopped
      // stores nothing, and "nothing rankable" would blame the site for it.
      //
      // And held back from the plan's money: discovery and its buyer test
      // leave qualification its room (lib/billing/run-budget.ts
      // `leavingRoom`). Without it they took everything they could, and a
      // first look whose research judged 360 phrases had $0.08 left to judge
      // results pages with - less than one term - and planned nothing.
      const runBudgetNow = currentSpendScope()?.budget ?? null;
      const researchBudget = runBudgetNow ? leavingRoom(runBudgetNow, firstLookResearchLeave(firstLookCeiling())) : undefined;
      const { value: analysis, refused: discoveryRefused } = await watchRefusals(() => timed("analysis", () => withSpendScope({ stage: "discovery", budget: researchBudget }, () => analyseDomain({
        domain,
        supabase,
        workspaceId: workspace.id,
        locale: workspace.language ?? "en",
        // Paired with the locale, or DataForSEO rejects the combination.
        locationCode: workspace.location_code ?? undefined,
        // What the wizard learned, so the keyword phase can seed from the
        // business and its audiences and not only from page headings.
        profile: (workspace.business_profile as BusinessProfile | null) ?? null,
        // A dozen pages is a voice and a vocabulary; the nightly pass reads the
        // rest. Every page here is one request against a host that may be
        // counting them (packhub.io bans after ten in forty seconds).
        maxPages: ONBOARDING_CRAWL_PAGES,
        // The rankings in hand go with it: the stored analysis is written
        // only when the whole keyword phase ends.
        onRead: ({ ranked }) => { void startPages(ranked); },
        // The speed test lands on the audit when it answers; nothing here
        // waits for it (it was a minute of a production first look).
        deferPageSpeed: true,
      }))));
      keywordsFound = analysis.keywordsFound;
      screened = analysis.screened;
      if (analysis.pageSpeedSettled) speedSettled = analysis.pageSpeedSettled;

      // What Google has already measured for this site, before anything the
      // model or a provider guessed. A workspace that connected Search Console
      // (the onboarding wizard offers it) has the queries it appears for
      // sitting in analytics_metrics; until 2026-09-17 nothing turned them
      // into keyword rows, so the picker could not see them. DataForSEO's
      // index does not know a young domain at all (altorank.co: 0 ranked
      // rows against 26 Search Console queries), which is exactly the
      // customer onboarding meets most.
      //
      // Database only, no provider call, and idempotent by term. Nothing here
      // can fail the phase: a workspace without the connection gets a
      // one-line "nothing synced" and the run carries on.
      const consoleSeeds = await timed("gsc_seed", () => seedKeywordsFromSearchConsole(supabase, workspace));
      keywordsFound += consoleSeeds.inserted;
      // "Nothing rankable found for this site yet" is only true when we were
      // able to look. When the site could not be read, `analyseDomain` stores
      // nothing on purpose and says why on its keywords layer - quoting that
      // is the difference between "your site has no demand" and "we could not
      // read your site", which are not the same news.
      const why = analysis.layers.find((l) => l.id === "keywords" && l.status === "unavailable")?.detail;
      // What the keyword work actually did, in its own words. `analyseDomain`
      // builds the breakdown - how many the site already ranks for, how many
      // came from the rivals the person named, how many were dropped as things
      // their buyers would not search - and this line used to throw it away
      // and print "Found 14 keywords worth tracking." A person reading the log
      // could not tell a good 14 from qasimcode.com's 14, eleven of which were
      // a rival's name or somebody shopping for a free portfolio site.
      const analysisBreakdown = analysis.layers.find((l) => l.id === "keywords" && l.status === "ok")?.detail;
      const breakdown = consoleSeeds.inserted
        ? [analysisBreakdown, consoleSeeds.detail].filter(Boolean).join(" ")
        : analysisBreakdown;
      // When the crawl itself failed, that is the news - not the keywords
      // layer's downstream "too little readable text", which packhub.io was
      // shown for a site with 379 words on its homepage. Quote the crawl's
      // own reason, and if it is the kind that clears on its own, say that the
      // next look is scheduled rather than handing the customer the job.
      const crawl = analysis.layers.find((l) => l.id === "crawl");
      const crawlFailed = crawl?.status === "failed" ? crawl.detail : null;
      const willRetry = crawlFailed !== null && isTransientCrawlFailure(crawlFailed);
      const budgetStopped = keywordsFound === 0 && discoveryRefused;
      researchFoundNothing = keywordsFound === 0 && crawlFailed === null && !why && !budgetStopped;
      emit({
        phase: "keywords",
        status: keywordsFound > 0 ? "done" : "skipped",
        detail:
          keywordsFound > 0
            ? (breakdown ?? `Found ${keywordsFound.toLocaleString()} keyword${keywordsFound === 1 ? "" : "s"} worth tracking.`)
            : willRetry
              ? `We could not reach your site just now (${crawlFailed}). The next look is already scheduled; keywords and the plan will follow without you doing anything.`
              : crawlFailed
                // The crawl failed for a reason that will not clear on its own.
                // Say the reason - it is the one fact that lets anyone act, and
                // the version that hid it behind "too little readable text" cost
                // a day of guessing about packhub.io. The run row is the only
                // place this reason is persisted.
                ? `Your site could not be read (${crawlFailed}). Add a keyword by hand from Keywords, or connect Search Console, and the plan can be built from there.`
                : why
                  ? `${why.charAt(0).toUpperCase()}${why.slice(1)}. Add a keyword by hand from Keywords, or connect Search Console, and the plan can be built from there.`
                  : budgetStopped
                    // The run's budget, not the site: say so.
                    ? "This first look's budget ran out before its keyword research finished, so no keyword was judged yet. Add a keyword by hand from Keywords, or connect Search Console, and the plan can be built from there."
                    : "Nothing rankable found for this site yet.",
        keywordsFound,
      });
    } catch (err) {
      emit({ phase: "keywords", status: "failed", detail: message(err) });
    }
  }

  // --- Phase 3: read the pages they already have ---------------------------
  //
  // Started above, beside the buyer test, when the keyword phase got that far;
  // started here when it did not (no keyword research on this install, a
  // keyword phase that failed early). Either way the plan waits for it, and
  // for the voice.
  await (startPages() ?? readExistingPages(supabase, workspace.id, domain, emit));
  await scanning;

  // --- Phase 4: schedule the month, then write the first draft ------------
  emit({ phase: "planning", status: "active" });
  // Four batches of up to fifteen results pages: about $0.25 at most, once.
  const FIRST_LOOK_QUALIFY_BATCHES = 4;
  let plan: PlannedEntry[] = [];
  // Where every candidate went (./funnel-event.ts): written down for every
  // run, planned or not, so an empty plan can be explained from one row.
  let planFunnel: TopicFunnel | null = null;
  let planningDetail: string | null = null;
  if (keywordsFound === 0) {
    planningDetail = "Nothing to schedule until there are keywords.";
    // Only when the research looked and found nothing: a site that could not
    // be read is a setup that fell short, and says so.
    const emptyPool = researchFoundNothing ? await emptyPoolOrNull(supabase, workspace.id) : null;
    emit({
      phase: "planning",
      status: "skipped",
      detail: planningDetail,
      ...(emptyPool ? { emptyPool } : {}),
    });
  } else {
    try {
      // An account that will be asked for a card gets one article on the
      // calendar and the rest held: the trial is what opens the month. The
      // planner decides that itself (lib/billing/trial-hold.ts), and this
      // asks it the same question only to word the screen. The held topics
      // are qualified rows with no calendar entry, read back by heldTopics
      // for the locked rows the screen shows. Everyone else - self-host,
      // operator, paying - gets the month as before.
      const hold = await planHold(supabase, workspace.id);
      const gated = hold !== "open";
      plan = await timed("plan", () => schedulePlan(supabase, workspace.id, workspace.auto_generate_weekly_limit ?? FREE_TIER_PACE, {
        maxEntries: 5,
        qualifyBatches: FIRST_LOOK_QUALIFY_BATCHES,
        firstLook,
        onFunnel: (f) => { planFunnel = f; },
        // The searches being checked, named on the screen while it happens.
        // The reducer keeps them only while the phase is active.
        onQualifyProgress: (p) =>
          emit({ phase: "planning", status: "active", checking: { terms: p.checking, judged: p.judged, qualified: p.qualified } }),
        // Not on the way to the gate: kept alive with the run's tail.
        questionsInBackground: (pending) => { questionsSettled = pending.then(() => undefined, () => undefined); },
      }));
      const held = gated && plan.length
        ? await heldTopics(supabase, workspace.id, workspace.auto_generate_weekly_limit ?? FREE_TIER_PACE, plan.map((p) => p.date)).catch(() => ({ count: 0, dates: [] }))
        : { count: 0, dates: [] };
      // Searches the right buyer makes that no article can win: the plan
      // leaves them out, and the person should hear about them, because the
      // page that wins them is theirs to build.
      let needsPage = 0;
      try {
        const { count } = await supabase
          .from("keywords")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspace.id)
          .eq("opportunity->>cause", "needs_page");
        needsPage = count ?? 0;
      } catch {
        // A count is a courtesy; a plan is not held up for it.
      }
      // A results page or a judge read that failed on the provider's side
      // (a 402 from an exhausted balance, an outage) leaves its term
      // `provider_error`. When nothing was planned and some were, the empty
      // plan is ours, not the site's: on 2026-10-12 every results page
      // answered 402 and the screen said "No keyword clear enough to plan
      // yet", as if the site had no topics.
      let providerFailed = 0;
      if (plan.length === 0) {
        try {
          const { count } = await supabase
            .from("keywords")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", workspace.id)
            .eq("opportunity->>cause", "provider_error");
          providerFailed = count ?? 0;
        } catch {
          // As above: the wording waits on nothing.
        }
      }
      const pageNote = needsPage
        ? ` ${needsPage} search${needsPage === 1 ? "" : "es"} your buyers make want${needsPage === 1 ? "s" : ""} a landing page rather than an article; see Keywords.`
        : "";
      // A second run for a held account plans nothing because the calendar
      // already holds its one article, which is not the same news as "no
      // keyword is clear enough".
      const firstAlreadyPlanned = gated && plan.length === 0 && (await countScheduled(supabase, workspace.id)) > 0;
      // The labels the plan carries, said in the line as well as on the cards.
      const lower = plan.filter((p) => p.brief?.confidence === "lower").length;
      const unmeasured = plan.filter((p) => p.brief?.demand === "unmeasured").length;
      // A top-of-funnel topic's reader has the problem, and is not shopping
      // yet: "a buyer" would be the wrong word for them.
      const who = plan.some((p) => p.brief?.funnel === "audience") ? "a reader you serve" : "a buyer";
      const labelNote = [
        lower ? ` ${lower === plan.length ? (plan.length === 1 ? "It is" : "They are") : `${lower} of them ${lower === 1 ? "is" : "are"}`} lower confidence: fewer than three topics cleared the bar, and fewer results for ${lower === 1 ? "that search" : "those searches"} are articles than we ask for.` : "",
        unmeasured && unmeasured === plan.length
          ? ` No search volume is reported for ${plan.length === 1 ? "it" : "them"} in your market yet (unmeasured).`
          : unmeasured
            ? ` ${unmeasured} of them ${unmeasured === 1 ? "has" : "have"} no search volume reported in your market yet (unmeasured); measured topics come first.`
            : "",
      ].join("");
      planningDetail =
        plan.length > 0
          ? held.count > 0
            ? `Scheduled your first article. ${held.count} more topic${held.count === 1 ? " is" : "s are"} ready, each with ${who} and supporting search evidence; the trial opens them.${labelNote}${pageNote}`
            : `Prepared ${plan.length} article${plan.length === 1 ? "" : "s"} for your calendar. Each topic has ${who} and supporting search evidence.${labelNote}${pageNote}`
          : firstAlreadyPlanned
            ? `Your first article is already on the calendar; the rest of the plan opens with the trial.${pageNote}`
            : providerFailed > 0
              ? `Could not check the search results for ${providerFailed} search${providerFailed === 1 ? "" : "es"}: a problem on our side, not your site. Nothing was planned yet.`
              : `No keyword clear enough to plan yet.${pageNote}`;
      // Nothing cleared the bar: which stage emptied the pool, for the row
      // and the operator (lib/onboarding/empty-pool.ts). Not for a held
      // account whose one article is already on the calendar - that site has
      // a plan - and not for one whose pre-trial article was already spent
      // (a second site): the planner returned nothing before it judged
      // anything, and the hold, not the pool, is why (review, 2026-09-29).
      const emptyPool =
        plan.length === 0 && !firstAlreadyPlanned && hold !== "spent" ? await emptyPoolOrNull(supabase, workspace.id) : null;
      emit({
        phase: "planning",
        status: plan.length > 0 ? "done" : "skipped",
        detail: planningDetail,
        planned: plan.map((p) => ({ term: p.term, date: p.date, brief: p.brief })),
        ...(emptyPool ? { emptyPool } : {}),
      });
    } catch (err) {
      planningDetail = message(err);
      emit({ phase: "planning", status: "failed", detail: planningDetail });
    }
  }
  emit({ phase: "drafting", status: "active" });
  // The status and detail the drafting phase settled on. The fan-out note
  // below is emitted on the same phase, and emitting it as `active` reset a
  // finished step back to a spinner - and, worse, replaced "Wrote 1,240 words
  // on X" with a sentence about the other six.
  let draftStatus: Exclude<PhaseStatus, "pending"> = "active";
  let draftDetail = "";
  const settle = (status: Exclude<PhaseStatus, "pending">, detail: string, article?: OnboardingArticle) => {
    draftStatus = status;
    draftDetail = detail;
    emit({ phase: "drafting", status, detail, article });
  };
  let pendingDraft: PendingDraft | null = null;
  /** Each planned term's share of the run's one related-keyword lookup. */
  let relatedByTerm = new Map<string, RelatedKeyword[]>();
  try {
    // A failed or empty article is not a preview. Keep active writes protected,
    // but allow a retry when no readable first draft exists.
    const { count } = await supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .or("status.eq.drafting,and(status.in.(review,approved,scheduled,live),content.not.is.null,word_count.gt.0)")
      .eq("workspace_id", workspace.id);
    if (count && count > 0) {
      settle("skipped", "This workspace already has a draft.");
    } else {
      // A cost gate, and an honest message when it bites. A no-plan account
      // gets FREE_DRAFTS a calendar month - seven since 2026-09-06, not one -
      // and onboarding is where the first of them is spent. The message counts
      // off the limit rather than restating a number that has already moved.
      const quota = await getQuota(supabase, workspace.account_id);
      // The trial hold first (lib/billing/trial-hold.ts): an account that
      // already has its one pre-trial article - on another site, or from a
      // run before this one - writes nothing more until the trial starts,
      // and the keyword research below is not bought for a draft that will
      // not be written. A trial cancelled before its first charge (a new site
      // added after the cancel) writes nothing either.
      const held = draftHoldReason(quota);
      if (held) {
        settle("skipped", held);
      } else if (quota.limit !== null && (quota.remaining ?? 0) <= 0) {
        // The one sentence the gates share (lib/billing/quota.ts). Written out
        // twice here, the paid half drifted: it said "Upgrade on the Billing
        // page to keep drafting", and a paid account at its limit does not
        // need to upgrade to keep drafting - it writes the next one by hand
        // and bills the overage. Onboarding is the worst screen to be wrong
        // about what the plan does, and the second copy is how it got wrong.
        settle("skipped", quotaExceededMessage(quota));
      } else {
        // Not 25: the list is cut after scoring across every action, and a
        // site with 25 page-one rankings filled it with skips before any
        // writable term appeared (lib/onboarding/plan.ts has the same note).
        const recs = await timed("first_topic", () => recommendKeywords(supabase, workspace.id, { limit: 1000, qualify: true, firstLook }));
        // The first day of the plan is what the person just watched get
        // scheduled; writing anything else would contradict the calendar.
        const first = plan[0];
        const next = (first && recs.find((r) => r.term === first.term)) ?? pickNextKeyword(recs);

        // The week's related keywords, in one paid task instead of seven.
        //
        // `keywords_for_keywords` is billed per TASK and takes up to twenty
        // seeds; the app sent one seed per task, so a signup that writes seven
        // drafts bought seven tasks - $0.63, a third of a measured $1.929
        // signup and three quarters of its DataForSEO half, for thirteen
        // usable rows in total (round4 §4, W2). Every keyword is already known
        // here: `next` plus the plan the person just watched get scheduled.
        //
        // Best effort in both directions. A failure leaves the map empty and
        // each draft buys its own lookup exactly as before; a seed the task
        // answers nothing for gets an empty list, which is an answer and is
        // not re-bought.
        //
        // In a first look the lookup is the draft's research and is paid from
        // the draft's stage, once, and only from room above what the writer
        // needs (lib/billing/run-budget.ts): bought here or not at all, the
        // draft is handed a list - empty when it was not bought - and does
        // not buy it again. Nothing is bought for a draft the budget cannot
        // write: the same pre-check the draft route makes, made first.
        //
        // A dispatched draft buys it itself, beside its outline and off the
        // way to the gate (lib/content/generate.ts): bought here it was ten
        // seconds of the worker's critical path before the draft could start.
        const budget = currentSpendScope()?.budget ?? null;
        const budgetShort = next ? await draftBudgetShort(budget) : null;
        relatedByTerm = next && budgetShort === null && firstDraft === "inline" && await draftCanBuyLookup(budget)
          ? await timed("related_keywords", () => withStage("draft", () => fetchWeeksRelatedKeywords(workspace, next.term, plan)))
          : new Map();
        const relatedFor = (term: string): RelatedKeyword[] | undefined => relatedByTerm.get(term) ?? (budget ? [] : undefined);

        if (!next) {
          settle("skipped", "No keyword clear enough to write to yet.");
        } else if (budgetShort !== null) {
          // Before the lookup, and in both modes: nothing is bought, and
          // nothing is dispatched, for a draft that cannot be written.
          settle("skipped", budgetShort);
        } else if (firstDraft === "dispatch") {
          // Chosen and gated here, written in its own invocation. The phase
          // stays `active` with the keyword named; the draft route settles it.
          pendingDraft = {
            term: next.term,
            keywordId: next.keywordId ?? null,
            selection: { reasons: next.reasons, score: next.score, difficulty: next.difficulty, volume: next.volume },
            // Not bought here: the draft route decides from its own room.
            relatedKeywords: undefined,
            ...(firstLook.serps?.get(next.term.trim().toLowerCase()) ? { serp: firstLook.serps.get(next.term.trim().toLowerCase())! } : {}),
          };
          settle("active", `Writing "${next.term}" now. It lands in your review queue when it is done.`);
        } else {
          const result = await withStage("draft", () => generateArticle({
            supabase,
            workspaceId: workspace.id,
            keyword: next.term,
            keywordId: next.keywordId,
            autonomous: true,
            selection: { reasons: next.reasons, score: next.score, difficulty: next.difficulty, volume: next.volume },
            relatedKeywords: relatedFor(next.term),
            // The one boundary inside the draft: research is done, the model
            // is about to write. Emitted as the same phase still active, with
            // a new detail, so the screen can say what is happening during the
            // longest silence in the run instead of showing a spinner for two
            // minutes.
            onResearch: (research) =>
              emit({
                phase: "drafting",
                status: "active",
                detail:
                  `Read ${research.competitors.length} ranking page${research.competitors.length === 1 ? "" : "s"}` +
                  // "and 0 questions people ask" read as a shortfall; none is
                  // simply not mentioned.
                  (research.peopleAlsoAsk.length
                    ? ` and ${research.peopleAlsoAsk.length} question${research.peopleAlsoAsk.length === 1 ? "" : "s"} people ask`
                    : "") +
                  ". Writing now.",
              }),
          }));
          const entry = plan.find((p) => p.term === next.term);
          if (entry) {
            const { data: row } = await supabase
              .from("calendar_entries")
              .select("id")
              .eq("workspace_id", workspace.id)
              .eq("keyword_id", entry.keywordId)
              .is("article_id", null)
              .maybeSingle();
            if (row?.id) await fulfilPlannedEntry(supabase, row.id as string, result.articleId);
          }
          settle("done", `Wrote ${result.wordCount.toLocaleString()} words on "${next.term}".`, {
            id: result.articleId,
            title: result.title,
            keyword: next.term,
            wordCount: result.wordCount,
            verdict: result.factCheck.verdict,
          });
        }
      }
    }
  } catch (err) {
    // A claim the budget refused part-way through the draft: skipped, as
    // the draft route says it, not a failed run.
    if (isBudgetRefusal(err)) settle("skipped", `${message(err)} A person picks the first article up.`);
    else settle("failed", message(err));
  }

  // What the first look has spent, by stage, on the same event - recorded
  // after the drafting phase, whose own qualification buys reads too. In
  // dispatch mode the draft is still to come and its reserve is on the row.
  const spend = readSpend ? await readSpend() : null;
  await recordPlanFunnel({ runId, workspaceId: workspace.id, accountId: workspace.account_id, funnel: withScreened(planFunnel, screened), planningDetail, spend, draftIncluded: firstDraft === "inline", timings: clock?.toJSON() ?? null });

  // The rest of the week waits for a person.
  //
  // This used to fan the remaining plan entries out as parallel draft
  // requests, so a signup had seven articles inside five minutes. Measured on
  // 2026-09-10 (packiyo.com, bookedin.com): the entire lifetime free
  // allowance spent before anyone had read a word, three of the seven on one
  // topic, two written for a buyer the business does not have. The first
  // draft is the wow; the other six are the customer's decision to make, once
  // they have seen what a draft looks like. cron/generate writes them at the
  // plan's pace, and on the free allowance only after the first has been
  // reviewed (lib/billing/first-draft-gate.ts).
  const fanOutSettled: Promise<void> = Promise.resolve();
  // `draftStatus` is assigned inside a closure above, which control flow
  // does not see; the read is deliberate.
  if (plan.length > 1 && (draftStatus as PhaseStatus) !== "skipped") {
    const rest = plan.length - 1;
    const note = `${rest} more ${rest === 1 ? "article is" : "articles are"} planned. They start once you have read this one.`;
    emit({
      phase: "drafting",
      // Whatever the first draft did stands. This is a note about the rest.
      status: draftStatus,
      detail: draftDetail ? `${draftDetail} ${note}` : note,
    });
  }

  // With a draft still to be written, the run is not over: the draft route
  // emits the equivalent of `ready` by settling the row when it lands.
  if (!pendingDraft) emit({ phase: "ready" });
  return { pendingDraft, fanOutSettled, tailSettled: Promise.all([speedSettled, questionsSettled]).then(() => undefined, () => undefined) };
}

/**
 * The empty pool, or null when it cannot be read. Null leaves the run
 * `partial`, the status it had before this existed, rather than claiming a
 * reason nobody could read; the failure is logged.
 */
async function emptyPoolOrNull(supabase: SupabaseClient, workspaceId: string): Promise<EmptyPool | null> {
  // No judge this run: whatever verdicts the rows carry are some earlier
  // run's, and "nothing cleared the bar" would be a claim this run did not
  // test. The same precondition qualification itself has (opportunity.ts).
  if (!modelAvailable() || !hasDataForSEOCredentials()) return null;
  try {
    return await readEmptyPool(supabase, workspaceId);
  } catch (err) {
    console.error(`[onboarding] empty-pool report for ${workspaceId}: ${message(err)}`);
    return null;
  }
}

/**
 * Read the pages the site already published, then fill the link pool from
 * its sitemap. Both best effort and both free; they are what the planner and
 * the writer read, not anything the keyword research needs.
 *
 * The wizard asks for the blog and says what it is for. Until 2026-09-06
 * nothing read it: the pages were only ever fetched by cron/site-pages, one
 * workspace a night, so on day one `site_pages` was empty and nothing in the
 * product knew what the customer had already published. A plain GET per page
 * and the checks in lib/seo/tech-audit.ts - no model, no DataForSEO - bounded
 * by ONBOARDING_CRAWL, and `assessExistingPages` never throws.
 *
 * Then the link pool: detectLinks reads the sitemap and the blog root (two
 * fetches, no API cost) into link_targets, which is the pool generateArticle
 * offers the writer. Measured on 2026-09-06 before it ran here: 0 internal
 * links on a first draft with 28 sitemap posts.
 */
async function readExistingPages(supabase: SupabaseClient, workspaceId: string, domain: string | null, emit: Emit, ranked?: RankedKeyword[]): Promise<void> {
  emit({ phase: "pages", status: "active" });
  if (domain && refusing(`https://${domain}/`)) {
    // More requests into a ban only extend it. The nightly pass reads the
    // pages when the host is not counting.
    emit({ phase: "pages", status: "skipped", detail: "The site is rate-limiting us right now; the nightly pass reads your existing pages." });
  } else if (!domain) {
    emit({ phase: "pages", status: "skipped", detail: "No domain to read pages from." });
  } else {
    const startedAt = Date.now();
    const pages = await timed("pages", () => assessExistingPages(supabase, workspaceId, domain, { ranked }));
    console.log(`[onboarding] pages: ${pages.status} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s - ${pages.detail}`);
    emit({ phase: "pages", status: pages.status, detail: pages.detail });
  }
  if (!domain) return;
  try {
    const pool = await timed("link_pool", () => detectLinks(supabase, workspaceId));
    if (pool.added > 0) console.log(`[onboarding] link pool: ${pool.added} page(s) from the site's own sources`);
  } catch (err) {
    console.warn("[onboarding] link pool detection failed:", message(err));
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * One `keywords_for_keywords` task for every draft this run will write.
 *
 * The seeds are the first draft's term plus the plan, capped at what actually
 * gets written now: the inline draft. Anything past that
 * is written by `cron/generate` days later, by which time a list bought today
 * would be stale as well as unpaid-for.
 *
 * Never throws. An empty map means every draft buys its own lookup, which is
 * what all of them did before this existed.
 */
async function fetchWeeksRelatedKeywords(
  workspace: Workspace,
  firstTerm: string,
  plan: PlannedEntry[],
): Promise<Map<string, RelatedKeyword[]>> {
  if (!hasDataForSEOCredentials()) return new Map();
  const terms: string[] = [];
  for (const term of [firstTerm, ...plan.map((p) => p.term)]) {
    if (term && !terms.includes(term)) terms.push(term);
    // One draft is written now; the plan's other entries buy their own when
    // cron/generate writes them, days later, when today's list would be stale.
    if (terms.length >= 1) break;
  }
  if (!terms.length) return new Map();
  const loc = getLocale(workspace.language ?? "en");
  try {
    return await fetchRelatedKeywordsBatch(terms, {
      languageCode: loc.languageCode,
      locationCode: workspace.location_code ?? loc.locationCode,
    });
  } catch (err) {
    console.warn("[onboarding] shared related-keyword lookup failed:", message(err));
    return new Map();
  }
}
