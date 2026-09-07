"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { analyzeVoice, trainVoiceProfile } from "@/lib/voice/train";

export async function createVoiceProfile(workspaceId: string, sampleText: string) {
  await requireAuth();
  const supabase = await createClient();
  // The work is in lib/voice/train.ts so the onboarding worker, which has no
  // session, can do the same thing with the service client.
  await trainVoiceProfile(supabase, workspaceId, sampleText);
  revalidatePath("/voice");
}

export async function updateVoiceProfile(id: string, data: { sample_text?: string; rules?: Record<string, unknown> }) {
  await requireAuth();
  const supabase = await createClient();

  const { error } = await supabase
    .from("voice_profiles")
    .update(data)
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/voice");
}

export async function retrainVoice(workspaceId: string) {
  await requireAuth();
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
