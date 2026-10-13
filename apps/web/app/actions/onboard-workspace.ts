"use server";

import { scrapeWebsiteText } from "@/lib/scraper";
import { createVoiceProfile } from "@/app/actions/voice";
import { getWorkspace } from "@/lib/queries/workspaces";

type VoiceResult = "trained" | "skipped" | "failed";

export async function scrapeAndTrainVoice(workspaceId: string): Promise<VoiceResult> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace?.domain) return "skipped";

  try {
    const text = await scrapeWebsiteText(workspace.domain);
    if (text && text.split(/\s+/).length > 50) {
      // The gate inside `createVoiceProfile` can refuse, and "trained" would
      // then be a claim about work that did not happen.
      const res = await createVoiceProfile(workspaceId, text);
      if (!res.ok) {
        console.warn("[onboard] Voice training refused:", res.error);
        return "skipped";
      }
      return "trained";
    }
    return "skipped";
  } catch (err) {
    console.error("[onboard] Voice training failed:", err);
    return "failed";
  }
}
