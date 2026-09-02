"use server";

import { scrapeWebsiteText } from "@/lib/scraper";
import { createVoiceProfile } from "@/app/actions/voice";
import { analyseDomain } from "@/lib/audit/domain-analysis";
import { generateArticle } from "@/lib/content/generate";
import { getQuota } from "@/lib/billing/quota";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { after } from "next/server";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { getWorkspace } from "@/lib/queries/workspaces";
import { createClient } from "@/lib/supabase/server";

type VoiceResult = "trained" | "skipped" | "failed";

type OnboardResult = {
  voice: VoiceResult;
  keywords: number | "skipped" | "failed";
};

export async function onboardWorkspace(workspaceId: string): Promise<OnboardResult> {
  const result: OnboardResult = { voice: "skipped", keywords: "skipped" };

  const workspace = await getWorkspace(workspaceId);
  if (!workspace?.domain) return result;

  // Step 1: Scrape website text and train voice profile
  try {
    const text = await scrapeWebsiteText(workspace.domain);
    if (text && text.split(/\s+/).length > 50) {
      await createVoiceProfile(workspaceId, text);
      result.voice = "trained";
    }
  } catch (err) {
    console.error("[onboard] Voice training failed:", err);
    result.voice = "failed";
  }

  // Step 2: the same first-look analysis the nightly cron runs.
  //
  // This used to call runKeywordResearch, which asks Google Ads what a domain
  // is about and stores whatever comes back. For supalabs.co that was 159
  // rows of "ai for companies", "ai of ai", "not ai": the category head, with
  // no site vocabulary to judge it against, because nothing had crawled the
  // site. analyseDomain builds the topical profile first, seeds discovery
  // with the site's own headings, drops provider fragments, ranks what it
  // stores by relevance, and records readiness, backlinks, authority and
  // traffic on the way. One path, one answer, whichever way a workspace is
  // created (2026-09-02).
  if (!hasDataForSEOCredentials()) {
    result.keywords = "skipped";
  } else {
    try {
      const supabase = await createClient();
      const analysis = await analyseDomain({
        domain: workspace.domain,
        supabase,
        workspaceId,
        locale: workspace.language ?? "en",
      });
      result.keywords = analysis.keywordsFound;
    } catch (err) {
      console.error("[onboard] Analysis failed:", err);
      result.keywords = "failed";
    }
  }

  // Step 3: the first draft, started here rather than waiting for tomorrow's
  // cron. "The first draft lands in your review queue" is the promise on the
  // wizard, and a person who just typed their domain should not have to wait
  // a day or find the New article button to see it. Bounded by the same quota
  // as everything else, skipped when the site could not be read well enough
  // to choose a keyword, and run after the response so the form returns at
  // once.
  after(async () => {
    try {
      const supabase = await createClient();
      const { count } = await supabase
        .from("articles")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId);
      if (count && count > 0) return;

      const quota = await getQuota(supabase, workspace.agency_id);
      if (quota.limit !== null && (quota.remaining ?? 0) <= 0) return;

      const recommendations = await recommendKeywords(supabase, workspaceId, { limit: 25 });
      const next = pickNextKeyword(recommendations);
      if (!next) return;

      await generateArticle({
        supabase,
        workspaceId,
        keyword: next.term,
        autonomous: true,
        selection: { reasons: next.reasons, score: next.score, difficulty: next.difficulty, volume: next.volume },
      });
    } catch (err) {
      console.error("[onboard] first draft:", err instanceof Error ? err.message : err);
    }
  });

  return result;
}

export async function scrapeAndTrainVoice(workspaceId: string): Promise<VoiceResult> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace?.domain) return "skipped";

  try {
    const text = await scrapeWebsiteText(workspace.domain);
    if (text && text.split(/\s+/).length > 50) {
      await createVoiceProfile(workspaceId, text);
      return "trained";
    }
    return "skipped";
  } catch (err) {
    console.error("[onboard] Voice training failed:", err);
    return "failed";
  }
}
