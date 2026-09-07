"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { analyzeVoice, trainVoiceProfile } from "@/lib/voice/train";
import { canSpend } from "@/lib/billing/spend-gate";
import type { BillingOutcome } from "@/lib/billing/failure";

// Training reads the site and asks the model to describe how it writes: one
// model call per press, and both buttons here can be pressed as often as
// someone likes. Neither was gated.
//
// The outcome is returned rather than thrown - a thrown server-action message
// is an opaque digest in production - and both callers now show it. Before
// this they did `console.error(err)` and nothing else, so a refusal was a
// button that did nothing at all.

export async function createVoiceProfile(
  workspaceId: string,
  sampleText: string,
): Promise<BillingOutcome> {
  const { agencyId, user } = await requireAuth();
  const supabase = await createClient();
  const gate = await canSpend(supabase, agencyId, {
    userEmail: user.email ?? undefined,
    workspaceId,
    action: "voice-training",
  });
  if (!gate.allowed) return { ok: false, error: gate.message };
  // The work is in lib/voice/train.ts so the onboarding worker, which has no
  // session, can do the same thing with the service client.
  await trainVoiceProfile(supabase, workspaceId, sampleText);
  revalidatePath("/voice");
  return { ok: true };
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

export async function retrainVoice(workspaceId: string): Promise<BillingOutcome> {
  const { agencyId, user } = await requireAuth();
  const supabase = await createClient();

  const gate = await canSpend(supabase, agencyId, {
    userEmail: user.email ?? undefined,
    workspaceId,
    action: "voice-training",
  });
  if (!gate.allowed) return { ok: false, error: gate.message };

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
  return { ok: true };
}
