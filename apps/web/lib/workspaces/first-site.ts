// ---------------------------------------------------------------------------
// The site a person names to get their first look
// ---------------------------------------------------------------------------
//
// Two doors make it: the signup form, which asks for the domain first, and
// /onboarding/site, for an account that reached the app with no site at all
// (an account the membership fallback made: lib/queries/account.ts). Both
// write the same row, so the second door cannot drift into a site that never
// drafts.

import { generateIndexNowKey } from "@/lib/seo/indexing";
import { FREE_TIER_PACE } from "@/lib/content/pace";

/** Where an account with no site is sent to name one (app/(setup)/onboarding/site). */
export const FIRST_SITE_PATH = "/onboarding/site";

/**
 * The workspace row for a person's first site, `domain` already normalised.
 *
 * The free drafts are delivered by onboarding (the first, inline) and the
 * generate cron and fan-out (the rest), all of which only write for opted-in
 * workspaces. A site named here is the opt-in: the person typed their domain
 * to get exactly this. Bounded by FREE_DRAFTS until they choose a plan; the
 * pace is FREE_TIER_PACE so the whole allowance lands inside the first week
 * rather than over seven of them. The Stripe webhook raises it to the paid
 * default when they subscribe.
 *
 * auto_approve is deliberately NOT set, so the column default (false,
 * migration 079) stands. Signup was once the only path that turned it on,
 * which recorded the new user as having "set" a rule they were never shown,
 * on the account least able to judge the drafts - and the product sells the
 * veto ("review ALWAYS", AGENTS.md), which the onboarding wizard states as an
 * ALWAYS ON card. Enabling it is a choice the person makes in workspace
 * settings, after they have read a draft.
 */
export function firstSiteRow(domain: string) {
  return {
    name: domain,
    domain,
    initials: domain.slice(0, 2).toUpperCase(),
    color: "av-c1",
    indexnow_key: generateIndexNowKey(),
    auto_generate: true,
    auto_generate_weekly_limit: FREE_TIER_PACE,
  };
}
