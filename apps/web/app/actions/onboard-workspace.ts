"use server";

import { scrapeWebsiteText } from "@/lib/scraper";
import { createVoiceProfile } from "@/app/actions/voice";
import { getWorkspace } from "@/lib/queries/workspaces";
import { createClient } from "@/lib/supabase/server";
import { runOnboarding, type Emit } from "@/lib/onboarding/pipeline";
import type { OnboardingEvent } from "@/lib/onboarding/events";

type VoiceResult = "trained" | "skipped" | "failed";

type OnboardResult = {
  voice: VoiceResult;
  keywords: number | "skipped" | "failed";
};

/**
 * Non-streaming onboarding, for callers with no screen to stream to
 * (google-properties imports a site straight into a workspace).
 *
 * Delegates to the same pipeline the SSE route uses, collecting its events into
 * a plain summary instead of forwarding them. The first draft is written inside
 * this call now rather than in an after() callback, so it is as reliable here as
 * on the streaming path - the reason the old fire-and-forget draft never
 * arrived until the nightly cron picked it up.
 */
export async function onboardWorkspace(workspaceId: string): Promise<OnboardResult> {
  const result: OnboardResult = { voice: "skipped", keywords: "skipped" };

  const workspace = await getWorkspace(workspaceId);
  if (!workspace?.domain) return result;

  const supabase = await createClient();
  const collect: Emit = (event: OnboardingEvent) => {
    if (event.phase === "scanning") {
      if (event.status === "done") result.voice = "trained";
      else if (event.status === "failed") result.voice = "failed";
      else if (event.status === "skipped") result.voice = "skipped";
    } else if (event.phase === "keywords") {
      if (event.status === "failed") result.keywords = "failed";
      else if (event.status === "skipped") result.keywords = "skipped";
      else if (typeof event.keywordsFound === "number") result.keywords = event.keywordsFound;
    }
  };

  await runOnboarding(
    supabase,
    { id: workspace.id, domain: workspace.domain, agency_id: workspace.agency_id, language: workspace.language ?? null },
    collect,
  );

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
