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
// The draft is AWAITED here, deliberately. It used to run in an after()
// callback fired from the onboarding action, and on serverless that callback is
// killed once the response is sent - so the "first draft" arrived hours later
// from the nightly cron, if at all (measured 2026-09-03: first drafts landed
// 5-19h after signup, never at onboarding). Awaiting it inside the request is
// what makes "your draft is ready" true when the screen says so. The nightly
// cron remains the backstop for a run that times out here.
//
// Every phase persists as it completes - createVoiceProfile writes the profile,
// analyseDomain writes keywords and metrics, generateArticle writes the
// article and its job - so a run cut short leaves real, partial state rather
// than nothing, and the dashboard shows whatever got done.

import type { SupabaseClient } from "@supabase/supabase-js";
import { readSiteText } from "./site-text";
import { createVoiceProfile } from "@/app/actions/voice";
import { analyseDomain } from "@/lib/audit/domain-analysis";
import { generateArticle } from "@/lib/content/generate";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { hasDataForSEOCredentials, setSpendReporter } from "@/lib/seo/client";
import { recordSpendByDefault } from "@/lib/billing/default-spend";
import type { OnboardingArticle, OnboardingEvent, PhaseStatus } from "./events";
import { schedulePlan, fulfilPlannedEntry, type PlannedEntry } from "./plan";
import { fanOutDrafts } from "@/lib/content/fan-out";
import { FREE_TIER_PACE } from "@/lib/content/pace";

export type Emit = (event: OnboardingEvent) => void;

interface Workspace {
  id: string;
  domain: string | null;
  agency_id: string;
  language: string | null;
  location_code?: number | null;
  auto_generate_weekly_limit?: number | null;
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
  /**
   * The request's abort signal. Checked at every phase boundary: a client that
   * disconnected (navigated away, or React re-ran the effect and aborted the
   * first fetch) should not have a full crawl and a paid article written for
   * nobody. Work already in flight finishes; nothing new starts.
   */
  signal?: AbortSignal,
): Promise<void> {
  const gone = () => signal?.aborted === true;

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
    await runPhases(supabase, workspace, emit, gone);
  } finally {
    setSpendReporter(null);
  }
}

async function runPhases(
  supabase: SupabaseClient,
  workspace: Workspace,
  emit: Emit,
  gone: () => boolean,
): Promise<void> {
  const domain = workspace.domain;

  // --- Phase 1: read the site, learn its voice ----------------------------
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
        await createVoiceProfile(workspace.id, text);
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

  if (gone()) return;

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
      });
      keywordsFound = analysis.keywordsFound;
      emit({
        phase: "keywords",
        status: keywordsFound > 0 ? "done" : "skipped",
        detail:
          keywordsFound > 0
            ? `Found ${keywordsFound.toLocaleString()} keyword${keywordsFound === 1 ? "" : "s"} worth tracking.`
            : "Nothing rankable found for this site yet.",
        keywordsFound,
      });
    } catch (err) {
      emit({ phase: "keywords", status: "failed", detail: message(err) });
    }
  }

  if (gone()) return;

  // --- Phase 3: write the first draft -------------------------------------
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

  if (gone()) return;
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
        const recs = await recommendKeywords(supabase, workspace.id, { limit: 25 });
        // The first day of the plan is what the person just watched get
        // scheduled; writing anything else would contradict the calendar.
        const first = plan[0];
        const next = (first && recs.find((r) => r.term === first.term)) ?? pickNextKeyword(recs);
        if (!next) {
          settle("skipped", "No keyword clear enough to write to yet.");
        } else {
          const result = await generateArticle({
            supabase,
            workspaceId: workspace.id,
            keyword: next.term,
            keywordId: next.keywordId,
            autonomous: true,
            selection: { reasons: next.reasons, score: next.score, difficulty: next.difficulty, volume: next.volume },
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
  // written here: this stream is already one draft in. Each gets its own
  // invocation instead, dispatched without waiting. They land in about the time
  // one takes rather than over the day the four-a-day cron would need.
  //
  // Anything that does not go out - no CRON_SECRET on a self-hosted install, a
  // request that never arrives - stays an unfulfilled plan entry, which is
  // exactly what cron/generate already looks for.
  if (!gone() && plan.length > 1) {
    const { data: written } = await supabase
      .from("calendar_entries")
      .select("keyword_id")
      .eq("workspace_id", workspace.id)
      .not("article_id", "is", null);
    const done = new Set((written ?? []).map((r) => r.keyword_id as string));
    const rest = plan
      .filter((p) => p.keywordId && !done.has(p.keywordId))
      .map((p) => ({ keywordId: p.keywordId as string, term: p.term }));
    const fan = fanOutDrafts(workspace.id, rest);
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

  emit({ phase: "ready" });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}
