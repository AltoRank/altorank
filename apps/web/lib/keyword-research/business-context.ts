// ---------------------------------------------------------------------------
// The business profile the buyer test judges against, built when it is missing
// ---------------------------------------------------------------------------
//
// Since #214 nothing is scheduled or written unattended without a buyer verdict
// and live search evidence. Both start from the business profile: what is
// sold, to whom, against whom. The wizard writes it for every account that has
// onboarded since it existed. Accounts older than the wizard - our own two
// among them - have none, and on 2026-09-14 the nightly cron stamped every one
// of their keywords "pending: buyer fit could not be confirmed" and wrote
// nothing, six runs in a row, with no way to tell from the log that the cause
// was an empty column.
//
// The rule stays. The evidence base is repaired at its source: a workspace
// with no usable profile gets one inferred from its own site, the same
// one-call inference the wizard proposes, persisted once. When the site
// cannot be read the caller gets the reason, and the verdicts say it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessProfile, InferenceReason } from "@/lib/onboarding/business-profile";
import { inferVerifiedBusinessProfile } from "@/lib/onboarding/observed-facts";
import type { SiteText } from "@/lib/onboarding/site-text";

/** The profile as every reader holds it: every field optional, because rows predate most of them. */
export interface BusinessFields {
  name?: string | null;
  description?: string | null;
  audiences?: string[] | null;
  offerings?: string[] | null;
  competitors?: string[] | null;
  competitorNames?: string[] | null;
  language?: string | null;
  country?: string | null;
}

export interface EnsuredProfile {
  business: BusinessFields | null;
  /** True when this call read the site and wrote the profile. */
  inferred: boolean;
  /** Why there is still no profile, when there is none. */
  missing: string | null;
}

/** A profile the judge can use: it needs at least a description. */
export function profileUsable(business: BusinessFields | null | undefined): boolean {
  return Boolean(business?.description && business.description.trim().length > 20);
}

const MISSING: Record<Exclude<InferenceReason, "ok">, string> = {
  no_model: "no business profile, and no model is configured to read the site for one",
  unreadable: "no business profile, and the site could not be read to build one",
  model_failed: "no business profile, and reading the site for one failed",
  needs_plan: "no business profile, and the account cannot spend on building one",
  limited: "no business profile, and the site has been read as often as allowed for now",
};

/**
 * The workspace's profile, inferring and saving it when it is unusable.
 *
 * Spend: one structured model call, once per workspace that lacks a profile.
 * Callers on the scheduled path have already passed the entitlement gate
 * for the workspace; the wizard path never reaches here because it holds
 * the profile the person confirmed - except a store installed from the
 * Shopify App Store, which skips the wizard (lib/onboarding/pipeline.ts).
 *
 * `read`: the text to infer from, when the caller already has it and the
 * site cannot be fetched (a locked Shopify storefront).
 */
export async function ensureBusinessProfile(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string | null | undefined,
  business: BusinessFields | null | undefined,
  opts: { read?: SiteText } = {},
): Promise<EnsuredProfile> {
  if (profileUsable(business)) return { business: business ?? null, inferred: false, missing: null };
  if (!domain) return { business: null, inferred: false, missing: "no business profile, and no domain to read one from" };

  // Observed URLs checked before they are saved, as in the wizard.
  const result = await inferVerifiedBusinessProfile(domain, { read: opts.read });
  if (result.reason !== "ok" || !result.profile) {
    return { business: null, inferred: false, missing: MISSING[result.reason as Exclude<InferenceReason, "ok">] ?? MISSING.model_failed };
  }
  // What the person had typed, if anything, outranks what the site says.
  const merged: BusinessProfile = {
    ...result.profile,
    audiences: business?.audiences?.length ? business.audiences : result.profile.audiences,
    competitors: business?.competitors?.length ? business.competitors : result.profile.competitors,
    offerings: business?.offerings?.length ? business.offerings : result.profile.offerings,
    // Names the owner gave with no website: the site read cannot know them.
    ...(business?.competitorNames?.length ? { competitorNames: business.competitorNames } : {}),
    // Read off the site by a model and saved with nobody looking: not
    // confirmed, and the writer is told so (lib/ai/prompts.ts).
    confirmedAt: null,
  };
  const persist: BusinessFields = merged;
  // A failed write is not a failed inference: the verdicts this run are
  // judged against the profile in hand, and the next run reads the site again.
  await supabase.from("workspaces").update({ business_profile: merged }).eq("id", workspaceId);
  return { business: persist, inferred: true, missing: null };
}
