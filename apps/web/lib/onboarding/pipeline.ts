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

import type { SupabaseClient } from "@supabase/supabase-js";
import { readSiteText } from "./site-text";
import { checkDomainReachable } from "@/lib/domain/reachable";
import { trainVoiceProfile } from "@/lib/voice/train";
import { analyseDomain, isTransientCrawlFailure } from "@/lib/audit/domain-analysis";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { generateArticle } from "@/lib/content/generate";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { hasDataForSEOCredentials, setSpendReporter } from "@/lib/seo/client";
import { recordSpendByDefault } from "@/lib/billing/default-spend";
import type { OnboardingArticle, OnboardingEvent, PhaseStatus } from "./events";
import { schedulePlan, fulfilPlannedEntry, type PlannedEntry } from "./plan";
import { fanOutDrafts, MAX_FAN_OUT } from "@/lib/content/fan-out";
import { fetchRelatedKeywordsBatch, type RelatedKeyword } from "@/lib/seo/brief-data";
import { getLocale } from "@/lib/seo/locales";
import { detectLinks } from "@/lib/linking/detect";
import { assessExistingPages } from "./site-assessment";
import { FREE_TIER_PACE } from "@/lib/content/pace";

export type Emit = (event: OnboardingEvent) => void;

export interface RunOnboardingOptions {
  /** See the header: `inline` awaits the draft here, `dispatch` returns it. */
  firstDraft?: "inline" | "dispatch";
}

/** The first draft, chosen and gated but not yet written, for the caller to dispatch. */
export interface PendingDraft {
  term: string;
  keywordId: string | null;
  selection: { reasons: string[]; score: number; difficulty: number | null; volume: number | null };
  /** This draft's share of the run's one related-keyword lookup, when it ran. */
  relatedKeywords?: RelatedKeyword[];
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
}

interface Workspace {
  id: string;
  domain: string | null;
  agency_id: string;
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
  // Every DataForSEO call this run makes belongs to this workspace. With no
  // reporter armed the client falls back to the unattributed default, and one
  // onboarding on 2026-09-05 left fourteen rows with no workspace_id - the
  // discovery that costs the most per site, and the one the per-site margin
  // cannot see. Written through the service role: the client handed to this
  // pipeline is the signed-in user's, and provider_spend refuses its inserts.
  // generateArticle arms its own, finer reporter (article and run) for the
  // draft and clears it after; the finally clears ours however the run ends.
  setSpendReporter(({ operation, costUsd }) => {
    recordSpendByDefault({ provider: "dataforseo", operation, costUsd, workspaceId: workspace.id });
  });
  try {
    return await runPhases(supabase, workspace, emit, options.firstDraft ?? "inline");
  } finally {
    setSpendReporter(null);
  }
}

async function runPhases(
  supabase: SupabaseClient,
  workspace: Workspace,
  emit: Emit,
  firstDraft: "inline" | "dispatch",
): Promise<RunOnboardingResult> {
  const domain = workspace.domain;

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
    const reach = await checkDomainReachable(domain);
    if (reach.verdict === "no-dns" || reach.verdict === "invalid") {
      emit({ phase: "scanning", status: "failed", detail: reach.reason });
      for (const phase of ["keywords", "pages", "planning", "drafting"] as const) {
        emit({ phase, status: "skipped", detail: "There is no site at this domain to work from." });
      }
      return { pendingDraft: null, fanOutSettled: Promise.resolve() };
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
  emit({ phase: "scanning", status: "active" });
  if (!domain) {
    emit({ phase: "scanning", status: "skipped", detail: "No domain on this workspace yet." });
  } else {
    try {
      // Same reader as the wizard: homepage, then the blog when the homepage
      // is a JavaScript shell, then a rendered fetch. A voice learned from the
      // site's own articles is better than one learned from its landing page.
      const read = await readSiteText(domain);
      const text = read.text;
      if (text && text.split(/\s+/).length > 50) {
        await trainVoiceProfile(supabase, workspace.id, text);
        emit({
          phase: "scanning",
          status: "done",
          detail: read.source === "sitemap" ? "Learned how your site writes, from its articles." : "Learned how your site writes.",
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

  // --- Phase 2: find what to write about ----------------------------------
  emit({ phase: "keywords", status: "active" });
  let keywordsFound = 0;
  if (!domain) {
    emit({ phase: "keywords", status: "skipped", detail: "No domain to analyse." });
  } else if (!hasDataForSEOCredentials()) {
    emit({ phase: "keywords", status: "skipped", detail: "Keyword research is not configured on this install." });
  } else {
    try {
      const analysis = await analyseDomain({
        domain,
        supabase,
        workspaceId: workspace.id,
        locale: workspace.language ?? "en",
        // Paired with the locale, or DataForSEO rejects the combination.
        locationCode: workspace.location_code ?? undefined,
        // What the wizard learned, so the keyword phase can seed from the
        // business and its audiences and not only from page headings.
        profile: (workspace.business_profile as BusinessProfile | null) ?? null,
      });
      keywordsFound = analysis.keywordsFound;
      // "Nothing rankable found for this site yet" is only true when we were
      // able to look. When the site could not be read, `analyseDomain` stores
      // nothing on purpose and says why on its keywords layer - quoting that
      // is the difference between "your site has no demand" and "we could not
      // read your site", which are not the same news.
      const why = analysis.layers.find((l) => l.id === "keywords" && l.status === "unavailable")?.detail;
      // When the crawl itself failed, that is the news - not the keywords
      // layer's downstream "too little readable text", which packhub.io was
      // shown for a site with 379 words on its homepage. Quote the crawl's
      // own reason, and if it is the kind that clears on its own, say that the
      // next look is scheduled rather than handing the customer the job.
      const crawl = analysis.layers.find((l) => l.id === "crawl");
      const crawlFailed = crawl?.status === "failed" ? crawl.detail : null;
      const willRetry = crawlFailed !== null && isTransientCrawlFailure(crawlFailed);
      emit({
        phase: "keywords",
        status: keywordsFound > 0 ? "done" : "skipped",
        detail:
          keywordsFound > 0
            ? `Found ${keywordsFound.toLocaleString()} keyword${keywordsFound === 1 ? "" : "s"} worth tracking.`
            : willRetry
              ? `We could not reach your site just now (${crawlFailed}). The next look is already scheduled; keywords and the plan will follow without you doing anything.`
              : why
                ? `${why.charAt(0).toUpperCase()}${why.slice(1)}. Add a keyword by hand from Keywords, or connect Search Console, and the plan can be built from there.`
                : "Nothing rankable found for this site yet.",
        keywordsFound,
      });
    } catch (err) {
      emit({ phase: "keywords", status: "failed", detail: message(err) });
    }
  }

  // --- Phase 3: read the pages they already have ---------------------------
  //
  // The wizard asks for the blog and says what it is for. Until now nothing
  // read it: detectLinks below harvests its URLs, and the pages themselves
  // were only ever fetched by cron/site-pages, which selects on
  // `first_analysed_at` and does one workspace a night. So on day one
  // `site_pages` was empty and nothing in the product knew what the customer
  // had already published.
  //
  // Free and technical: a plain GET per page and the checks in
  // lib/seo/tech-audit.ts, which read status codes, tag lengths, H1 counts,
  // canonicals and robots directives. No model, no DataForSEO. Bounded by
  // ONBOARDING_CRAWL so a 600-post blog cannot eat the worker's 300 seconds,
  // and best-effort: `assessExistingPages` never throws.
  emit({ phase: "pages", status: "active" });
  if (!domain) {
    emit({ phase: "pages", status: "skipped", detail: "No domain to read pages from." });
  } else {
    const startedAt = Date.now();
    const pages = await assessExistingPages(supabase, workspace.id, domain);
    // The number the budget is set against. Logged rather than shown: the
    // customer wants to know what was found, and whoever tunes ONBOARDING_CRAWL
    // wants to know how long it took on a real site.
    console.log(
      `[onboarding] pages: ${pages.status} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s - ${pages.detail}`,
    );
    emit({ phase: "pages", status: pages.status, detail: pages.detail });
  }

  // --- The link pool, before anything is written ---------------------------
  //
  // The wizard asks for the sitemap and says what it is for: "Used to find
  // your existing pages for internal links." Until now nothing read it until
  // a person pressed Detect on /linking, or the site-pages cron ran - and
  // that cron is on no schedule (vercel.json, .github/workflows). So the
  // first draft, and every draft after it, was written against an empty
  // pool: the prompt said "do not add any" internal links, on a site with a
  // 200-post blog it had just been told about. Measured on altorank.co,
  // 2026-09-06: 0 internal links on a first draft with 28 sitemap posts.
  //
  // detectLinks reads the sitemap and the blog root (two fetches, no API
  // cost) into link_targets, which is the pool generateArticle offers the
  // writer. Best effort: a sitemap that cannot be read is a draft without
  // internal links, not a failed onboarding.
  if (domain) {
    try {
      const pool = await detectLinks(supabase, workspace.id);
      if (pool.added > 0) console.log(`[onboarding] link pool: ${pool.added} page(s) from the site's own sources`);
    } catch (err) {
      console.warn("[onboarding] link pool detection failed:", message(err));
    }
  }

  // --- Phase 4: schedule the month, then write the first draft ------------
  emit({ phase: "planning", status: "active" });
  let plan: PlannedEntry[] = [];
  if (keywordsFound === 0) {
    emit({ phase: "planning", status: "skipped", detail: "Nothing to schedule until there are keywords." });
  } else {
    try {
      plan = await schedulePlan(supabase, workspace.id, workspace.auto_generate_weekly_limit ?? FREE_TIER_PACE);
      emit({
        phase: "planning",
        status: plan.length > 0 ? "done" : "skipped",
        detail:
          plan.length > 0
            ? `Planned ${plan.length} article${plan.length === 1 ? "" : "s"} over the next 30 days. Drag, drop or delete any of them.`
            : "No keyword clear enough to plan yet.",
        planned: plan.map((p) => ({ term: p.term, date: p.date })),
      });
    } catch (err) {
      emit({ phase: "planning", status: "failed", detail: message(err) });
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
    // Not if one already exists: this pipeline can be re-run, and a second
    // identical draft is worse than none.
    const { count } = await supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id);
    if (count && count > 0) {
      settle("skipped", "This workspace already has a draft.");
    } else {
      // A cost gate, and an honest message when it bites. A no-plan account
      // gets FREE_DRAFTS a calendar month - seven since 2026-09-06, not one -
      // and onboarding is where the first of them is spent. The message counts
      // off the limit rather than restating a number that has already moved.
      const quota = await getQuota(supabase, workspace.agency_id);
      if (quota.limit !== null && (quota.remaining ?? 0) <= 0) {
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
        const recs = await recommendKeywords(supabase, workspace.id, { limit: 1000 });
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
        relatedByTerm = next ? await fetchWeeksRelatedKeywords(workspace, next.term, plan) : new Map();

        if (!next) {
          settle("skipped", "No keyword clear enough to write to yet.");
        } else if (firstDraft === "dispatch") {
          // Chosen and gated here, written in its own invocation. The phase
          // stays `active` with the keyword named; the draft route settles it.
          pendingDraft = {
            term: next.term,
            keywordId: next.keywordId ?? null,
            selection: { reasons: next.reasons, score: next.score, difficulty: next.difficulty, volume: next.volume },
            relatedKeywords: relatedByTerm.get(next.term),
          };
          settle("active", `Writing "${next.term}" now. It lands in your review queue when it is done.`);
        } else {
          const result = await generateArticle({
            supabase,
            workspaceId: workspace.id,
            keyword: next.term,
            keywordId: next.keywordId,
            autonomous: true,
            selection: { reasons: next.reasons, score: next.score, difficulty: next.difficulty, volume: next.volume },
            relatedKeywords: relatedByTerm.get(next.term),
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
                  ` and ${research.peopleAlsoAsk.length} question${research.peopleAlsoAsk.length === 1 ? "" : "s"} people ask. Writing now.`,
              }),
          });
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
    settle("failed", message(err));
  }

  // The rest of the week, in parallel.
  //
  // One draft is ~103s and a function has 300s, so the remaining six cannot be
  // written here. Each gets its own invocation instead, dispatched without
  // waiting. They land in about the time one takes rather than over the day
  // the four-a-day cron would need.
  //
  // Anything that does not go out - no CRON_SECRET on a self-hosted install, a
  // request that never arrives - stays an unfulfilled plan entry, which is
  // exactly what cron/generate already looks for.
  let fanOutSettled: Promise<void> = Promise.resolve();
  if (plan.length > 1) {
    const { data: written } = await supabase
      .from("calendar_entries")
      .select("keyword_id")
      .eq("workspace_id", workspace.id)
      .not("article_id", "is", null);
    const done = new Set((written ?? []).map((r) => r.keyword_id as string));
    // A dispatched first draft has no article yet, so its entry still reads
    // as unwritten here; it is the one the draft route is about to write.
    if (pendingDraft?.keywordId) done.add(pendingDraft.keywordId);
    const rest = plan
      .filter((p) => p.keywordId && !done.has(p.keywordId))
      .map((p) => ({
        keywordId: p.keywordId as string,
        term: p.term,
        relatedKeywords: relatedByTerm.get(p.term),
      }));
    const fan = fanOutDrafts(workspace.id, rest);
    fanOutSettled = fan.settled;
    if (fan.dispatched > 0) {
      const note = `Writing ${fan.dispatched} more article${fan.dispatched === 1 ? "" : "s"} now. They appear as they finish.`;
      emit({
        phase: "drafting",
        // Whatever the first draft did stands. This is a note about the rest.
        status: draftStatus,
        detail: draftDetail ? `${draftDetail} ${note}` : note,
      });
    }
  }

  // With a draft still to be written, the run is not over: the draft route
  // emits the equivalent of `ready` by settling the row when it lands.
  if (!pendingDraft) emit({ phase: "ready" });
  return { pendingDraft, fanOutSettled };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * One `keywords_for_keywords` task for every draft this run will write.
 *
 * The seeds are the first draft's term plus the plan, capped at what actually
 * gets written now: the inline draft and MAX_FAN_OUT more. Anything past that
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
    if (terms.length >= MAX_FAN_OUT + 1) break;
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
