import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { OnboardingWizard } from "@/components/onboarding/wizard";
import { SITE_STEPS, stepFromParam } from "@/lib/onboarding/steps";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { outputFromRow } from "@/lib/onboarding/output-settings";
import { FREE_TIER_PACE } from "@/lib/content/pace";
import { requireAuth } from "@/lib/auth/require-auth";
import { getRequestQuota } from "@/lib/queries/quota";
import { latestRun } from "@/lib/onboarding/run-store";

export const metadata: Metadata = { title: "Set up your site" };

// Reading the site and asking a model about it happens inside a server action
// from this page; give it room.
export const maxDuration = 120;

/**
 * The wizard, for the scoped workspace.
 *
 * Scoped like every other page: the workspace comes from the switcher, not from
 * a query parameter, so a person with two sites sets up the one they are
 * looking at. A saved profile, site details and output settings are handed
 * back in so reopening the wizard edits rather than re-proposes.
 */
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const { step } = await searchParams;
  const scopeId = await getScopedWorkspaceId();
  if (!scopeId) redirect("/workspaces");

  const supabase = await createClient();
  // What the account may actually have written before it needs a plan. The
  // wizard promises a thirty-day plan; on the free tier only the first week of
  // it can be written, and until now nothing said so (P1-A1). Null when
  // unmetered, and then there is nothing to qualify.
  const authRead = requireAuth();
  const quotaRead = authRead.then(({ agencyId, user }) => getRequestQuota(agencyId, user.email ?? null));
  const [{ data: workspace }, { data: output }, quota, run, auth] = await Promise.all([
    supabase
      .from("workspaces")
      // The account's answer rides along on the workspace's own account row,
      // so the question is asked of the account that owns this site, once, and
      // not again for its second site.
      .select("id, domain, business_profile, sitemap_url, blog_root_url, example_article_urls, auto_generate_weekly_limit, auto_approve, agencies(attribution_source)")
      .eq("id", scopeId)
      .single(),
    supabase
      .from("workspace_output_settings")
      .select("tone, internal_links, table_of_contents, call_to_action, first_person, mention_similar_products, global_article_prompt")
      .eq("workspace_id", scopeId)
      .maybeSingle(),
    quotaRead,
    // The run in progress, or the one just finished, so a reload lands on
    // the run screen rather than on step 1. Same read /api/onboard/state
    // serves the polling; through the user's client, so RLS decides.
    latestRun(supabase, scopeId),
    authRead,
  ]);
  if (!workspace) redirect("/workspaces");

  // A many-to-one embed comes back as one object; the untyped client can only
  // promise an array, so both shapes are read rather than one asserted.
  const account = workspace.agencies as { attribution_source: string | null } | { attribution_source: string | null }[] | null;
  const answered = Boolean((Array.isArray(account) ? account[0] : account)?.attribution_source);

  const initialOutput = outputFromRow(output);

  return (
    <OnboardingWizard
      workspaceId={workspace.id}
      userId={auth.user.id}
      userEmail={auth.user.email ?? undefined}
      userProfileName={typeof auth.user.user_metadata.name === "string" ? auth.user.user_metadata.name : undefined}
      domain={workspace.domain ?? ""}
      // The same fallback the planner uses (app/actions/plan.ts) and the
      // same default the column carries since migration 042. This said 1,
      // seven times lower, so a null column made the wizard promise "1
      // article a week" for a site the planner would schedule seven for.
      weeklyLimit={workspace.auto_generate_weekly_limit ?? FREE_TIER_PACE}
      freeDrafts={quota.reason === "no-plan" ? Math.max(0, quota.remaining ?? 0) : null}
      initialProfile={(workspace.business_profile as BusinessProfile | null) ?? null}
      initialSite={{
        sitemapUrl: workspace.sitemap_url ?? "",
        blogRootUrl: workspace.blog_root_url ?? "",
        exampleArticleUrls: (workspace.example_article_urls as string[] | null) ?? [],
      }}
      initialOutput={initialOutput}
      askAttribution={!answered}
      initialStep={stepFromParam(step, SITE_STEPS.length + (answered ? 0 : 1))}
      initialRun={run}
      initialAutoApprove={Boolean(workspace.auto_approve)}
    />
  );
}
