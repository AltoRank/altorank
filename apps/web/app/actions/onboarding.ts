"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * `completeOnboardingStep` used to live here. It wrote
 * `user_metadata.onboarding_steps`, and the tour called it from its own "Got
 * it" button, so the checklist recorded that someone had read an explainer as
 * if they had connected a CMS.
 *
 * Progress is counted from the tables now (`lib/queries/onboarding.ts`), which
 * leaves nothing to persist and nothing that can drift out of agreement with
 * the account.
 *
 * The dismissal below stays, because it is the one thing here that genuinely
 * is a stored preference rather than a fact about the data.
 */
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
