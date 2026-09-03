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
import { scrapeWebsiteText } from "@/lib/scraper";
import { createVoiceProfile } from "@/app/actions/voice";
import { analyseDomain } from "@/lib/audit/domain-analysis";
import { generateArticle } from "@/lib/content/generate";
import { getQuota } from "@/lib/billing/quota";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import type { OnboardingEvent } from "./events";

export type Emit = (event: OnboardingEvent) => void;

interface Workspace {
  id: string;
  domain: string | null;
  agency_id: string;
  language: string | null;
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
): Promise<void> {
  const domain = workspace.domain;

  // --- Phase 1: read the site, learn its voice ----------------------------
  emit({ phase: "scanning", status: "active" });
  if (!domain) {
    emit({ phase: "scanning", status: "skipped", detail: "No domain on this workspace yet." });
  } else {
    try {
      const text = await scrapeWebsiteText(domain);
      if (text && text.split(/\s+/).length > 50) {
        await createVoiceProfile(workspace.id, text);
        emit({ phase: "scanning", status: "done", detail: "Learned how your site writes." });
      } else {
        emit({ phase: "scanning", status: "skipped", detail: "Too little text on the site to learn a voice." });
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

  // --- Phase 3: write the first draft -------------------------------------
  emit({ phase: "drafting", status: "active" });
  try {
    // Not if one already exists: this pipeline can be re-run, and a second
    // identical draft is worse than none.
    const { count } = await supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id);
    if (count && count > 0) {
      emit({ phase: "drafting", status: "skipped", detail: "This workspace already has a draft." });
    } else {
      // A cost gate, and an honest message when it bites. A no-plan account gets
      // one free draft; onboarding is where it is spent.
      const quota = await getQuota(supabase, workspace.agency_id);
      if (quota.limit !== null && (quota.remaining ?? 0) <= 0) {
        emit({ phase: "drafting", status: "skipped", detail: "Your free draft is already used. Choose a plan to keep drafting." });
      } else {
        const next = pickNextKeyword(await recommendKeywords(supabase, workspace.id, { limit: 25 }));
        if (!next) {
          emit({ phase: "drafting", status: "skipped", detail: "No keyword clear enough to write to yet." });
        } else {
          const result = await generateArticle({
            supabase,
            workspaceId: workspace.id,
            keyword: next.term,
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
          emit({
            phase: "drafting",
            status: "done",
            detail: `Wrote ${result.wordCount.toLocaleString()} words on "${next.term}".`,
            article: {
              id: result.articleId,
              title: result.title,
              keyword: next.term,
              wordCount: result.wordCount,
              verdict: result.factCheck.verdict,
            },
          });
        }
      }
    }
  } catch (err) {
    emit({ phase: "drafting", status: "failed", detail: message(err) });
  }

  emit({ phase: "ready" });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}
