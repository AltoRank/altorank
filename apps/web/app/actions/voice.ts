"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { analyzeVoiceWithAI } from "@/lib/ai/voice-analyzer";

export async function createVoiceProfile(workspaceId: string, sampleText: string) {
  const supabase = await createClient();

  const rules = await analyzeVoice(sampleText);

  const { error } = await supabase
    .from("voice_profiles")
    .upsert({
      workspace_id: workspaceId,
      sample_text: sampleText,
      rules,
      trained: true,
      created_at: new Date().toISOString(),
    }, {
      onConflict: "workspace_id",
    });

  if (error) throw new Error(error.message);
  revalidatePath("/voice");
}

export async function updateVoiceProfile(id: string, data: { sample_text?: string; rules?: Record<string, unknown> }) {
  const supabase = await createClient();

  const { error } = await supabase
    .from("voice_profiles")
    .update(data)
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/voice");
}

export async function retrainVoice(workspaceId: string) {
  const supabase = await createClient();

  const { data: profile } = await supabase
    .from("voice_profiles")
    .select("*")
    .eq("workspace_id", workspaceId)
    .single();

  if (!profile?.sample_text) throw new Error("No sample text to train from");

  const rules = await analyzeVoice(profile.sample_text);

  const { error } = await supabase
    .from("voice_profiles")
    .update({ rules, trained: true })
    .eq("workspace_id", workspaceId);

  if (error) throw new Error(error.message);
  revalidatePath("/voice");
}

/**
 * Analyze voice — tries AI-powered analysis first, falls back to local heuristics.
 */
async function analyzeVoice(sample: string): Promise<Record<string, unknown>> {
  try {
    return await analyzeVoiceWithAI([sample]) as Record<string, unknown>;
  } catch {
    // Fallback to local analysis when API key is missing or AI fails
    return analyzeVoiceLocally(sample);
  }
}

/**
 * Local voice analysis — extracts tone, vocabulary patterns, and style rules from sample text.
 * Runs without AI as a fallback.
 */
function analyzeVoiceLocally(sample: string): Record<string, unknown> {
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

  if (sample.includes("\u2014")) {
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
