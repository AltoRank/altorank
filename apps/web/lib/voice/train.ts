// ---------------------------------------------------------------------------
// Learning how a site writes
// ---------------------------------------------------------------------------
//
// The analysis and the write, with the client handed in. The server action in
// app/actions/voice.ts wraps this with the session check and the revalidate;
// the onboarding worker calls it with the service client, because it has no
// session. Until 2026-09-07 the pipeline called the action itself, which was
// fine inside the SSE request (the cookies were there) and failed the moment
// the run moved to its own invocation: "Could not read your site — Not
// authenticated", on every run, from the one phase that needs no
// authorisation beyond the workspace id.

import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeVoiceWithAI } from "@/lib/ai/voice-analyzer";

/** Analyse a sample and upsert the workspace's voice profile from it. */
export async function trainVoiceProfile(supabase: SupabaseClient, workspaceId: string, sampleText: string): Promise<void> {
  const rules = await analyzeVoice(sampleText);

  const { error } = await supabase
    .from("voice_profiles")
    .upsert(
      {
        workspace_id: workspaceId,
        sample_text: sampleText,
        rules,
        trained: true,
        created_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id" },
    );

  if (error) throw new Error(error.message);
}

/**
 * Analyze voice — tries AI-powered analysis first, falls back to local heuristics.
 */
export async function analyzeVoice(sample: string): Promise<Record<string, unknown>> {
  try {
    return (await analyzeVoiceWithAI([sample])) as Record<string, unknown>;
  } catch {
    // Fallback to local analysis when API key is missing or AI fails
    return analyzeVoiceLocally(sample);
  }
}

/**
 * Local voice analysis — extracts tone, vocabulary patterns, and style rules from sample text.
 * Runs without AI as a fallback.
 */
export function analyzeVoiceLocally(sample: string): Record<string, unknown> {
  const sentences = sample.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = sample.toLowerCase().split(/\s+/);
  const avgSentenceLength = Math.round(words.length / Math.max(sentences.length, 1));

  const tags: string[] = [];

  if (/\b(don't|won't|can't|isn't|aren't|we're|they're|it's|that's|we've)\b/i.test(sample)) {
    tags.push("contractions OK");
  } else {
    tags.push("formal (no contractions)");
  }

  if (avgSentenceLength <= 15) {
    tags.push("short sentences");
  } else if (avgSentenceLength > 25) {
    tags.push("long-form");
  }

  if (sample.includes("—")) {
    tags.push("uses em-dashes");
  } else {
    tags.push("no em-dashes");
  }

  if (/\b(we|our|us)\b/i.test(sample)) {
    tags.push("first-person plural");
  }
  if (/\b(I|my|me)\b/.test(sample)) {
    tags.push("first-person singular");
  }

  if (/\b(you|your)\b/i.test(sample)) {
    tags.push("direct address");
  }

  if (/\b(don't|won't|stop|never|avoid)\b/i.test(sample)) {
    tags.push("direct");
  }
  if (avgSentenceLength <= 12) {
    tags.push("punchy");
  }

  return {
    tags,
    avgSentenceLength,
    wordCount: words.length,
    sentenceCount: sentences.length,
  };
}
