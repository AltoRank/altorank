import { createClient } from "@/lib/supabase/server";
import type { StepId } from "@/components/onboarding/onboarding-steps";

/**
 * Which setup steps this account has actually done.
 *
 * Read from the tables, not from a flag. The checklist used to be stored in
 * `user_metadata.onboarding_steps`, written by the tour itself: clicking "Got
 * it" on an explainer marked the step done. Four clicks of "Next step" and the
 * panel said "All done! You're all set to start ranking" over an account with
 * no client, no keywords, no CMS and no voice.
 *
 * That is this repo's fifth hard rule in the one place it does the most damage.
 * A checklist is a claim about the state of an account, and the only thing that
 * makes "CMS connected" true is a row in `workspace_integrations`.
 *
 * Deriving it also means it self-corrects. Delete the last client and the step
 * un-ticks on the next load, which a stored flag could never do.
 *
 * `SetupWizard` had this right all along - `voiceDone = !!voice?.trained` - so
 * this is the two implementations of one behaviour being reconciled, not a new
 * idea.
 */
export async function getCompletedOnboardingSteps(): Promise<
  Record<StepId, boolean>
> {
  const supabase = await createClient();

  // Head counts: no rows come back, and RLS scopes every one of them to the
  // signed-in account.
  const count = async (table: string, eq?: [string, unknown]) => {
    let q = supabase.from(table).select("id", { count: "exact", head: true });
    if (eq) q = q.eq(eq[0], eq[1]);
    const { count: n } = await q;
    return (n ?? 0) > 0;
  };

  const [client, keywords, article, cms, voice] = await Promise.all([
    count("workspaces"),
    count("keywords"),
    count("articles"),
    // `integrations` is the catalogue of platforms we support and is never
    // empty. `workspace_integrations` is a connection someone actually made.
    count("workspace_integrations"),
    // A profile row exists from the moment training is attempted. Only a
    // trained one changes what gets written.
    count("voice_profiles", ["trained", true]),
  ]);

  return {
    "add-workspace": client,
    "add-keywords": keywords,
    "generate-article": article,
    "connect-cms": cms,
    "train-voice": voice,
  };
}
