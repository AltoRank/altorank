"use server";

import { scrapeWebsiteText } from "@/lib/scraper";
import { createVoiceProfile } from "@/app/actions/voice";
import { runKeywordResearch } from "@/app/actions/seo";
import { getWorkspace } from "@/lib/queries/workspaces";

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
  if (!process.env.DATAFORSEO_LOGIN) {
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
