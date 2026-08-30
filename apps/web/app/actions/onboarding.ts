"use server";

import { createClient } from "@/lib/supabase/server";
import type { StepId } from "@/components/onboarding/onboarding-steps";

export async function completeOnboardingStep(stepId: StepId) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const meta = user.user_metadata ?? {};
  const steps: Record<string, boolean> = meta.onboarding_steps ?? {};
  steps[stepId] = true;

  const allDone = [
    "add-client",
    "add-keywords",
    "generate-article",
    "connect-cms",
    "train-voice",
  ].every((id) => steps[id]);

  const { error } = await supabase.auth.updateUser({
    data: {
      onboarding_steps: steps,
      ...(allDone ? { onboarding_completed: true } : {}),
    },
  });

  if (error) return { error: error.message };
  return { success: true, allDone };
}

export async function dismissOnboarding() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { error } = await supabase.auth.updateUser({
    data: { onboarding_dismissed: true },
  });

  if (error) return { error: error.message };
  return { success: true };
}
