import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
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
  // The site the sidebar is scoped to. The checklist sits beside pages that
  // are all about one site, and until 2026-09-07 it counted the account: an
  // agency's second client showed "CMS connected" and "voice trained" on the
  // day it was added, because the first client had done both. `null` (the
  // "all sites" view, or an operator with no scope) keeps the account-wide
  // count, which is the only honest answer there.
  const scopeId = await getScopedWorkspaceId();

  // Head counts: no rows come back, and RLS scopes every one of them to the
  // signed-in account. `scoped` tables narrow to the site as well.
  const count = async (table: string, opts: { scoped?: boolean; eq?: [string, unknown] } = {}) => {
    let q = supabase.from(table).select("id", { count: "exact", head: true });
    if (opts.scoped && scopeId) q = q.eq("workspace_id", scopeId);
    if (opts.eq) q = q.eq(opts.eq[0], opts.eq[1]);
    const { count: n } = await q;
    return (n ?? 0) > 0;
  };

  const [client, keywords, article, cms, voice] = await Promise.all([
    // The account has a site at all: this one is about the account.
    count("workspaces"),
    count("keywords", { scoped: true }),
    count("articles", { scoped: true }),
    // `integrations` is the catalogue of platforms we support and is never
    // empty. `workspace_integrations` is a connection someone actually made.
    count("workspace_integrations", { scoped: true }),
    // A profile row exists from the moment training is attempted. Only a
    // trained one changes what gets written.
    count("voice_profiles", { scoped: true, eq: ["trained", true] }),
  ]);

  return {
    "add-workspace": client,
    "add-keywords": keywords,
    "generate-article": article,
    "connect-cms": cms,
    "train-voice": voice,
  };
}
