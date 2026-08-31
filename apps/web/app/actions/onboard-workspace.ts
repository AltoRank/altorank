"use server";

import { scrapeWebsiteText } from "@/lib/scraper";
import { createVoiceProfile } from "@/app/actions/voice";
import { runKeywordResearch } from "@/app/actions/seo";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { getWorkspace } from "@/lib/queries/workspaces";
import { fetchDomainMetrics } from "@/lib/seo/domain-metrics";
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

  // Step 2: Run keyword research (only if DataForSEO is configured)
  if (!hasDataForSEOCredentials()) {
    result.keywords = "skipped";
  } else {
    try {
      const { discovered } = await runKeywordResearch(workspaceId);
      result.keywords = discovered;
    } catch (err) {
      console.error("[onboard] Keyword research failed:", err);
      result.keywords = "failed";
    }
  }

  // Step 3: Authority and traffic. These columns rendered as dashes on every
  // workspace because nothing ever measured them; the numbers were one call
  // away on the account we already pay. Best-effort: nulls stay null.
  try {
    const metrics = await fetchDomainMetrics(workspace.domain, {
      languageCode: workspace.language ?? "en",
      locationCode: workspace.location_code ?? 2840,
    });
    if (metrics.authority !== null || metrics.traffic !== null) {
      const supabase = await createClient();
      await supabase
        .from("workspaces")
        .update({
          ...(metrics.authority !== null ? { dr: metrics.authority } : {}),
          ...(metrics.traffic !== null ? { traffic: metrics.traffic } : {}),
        })
        .eq("id", workspaceId);
    }
  } catch (err) {
    console.error("[onboard] Domain metrics failed:", err);
  }

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
