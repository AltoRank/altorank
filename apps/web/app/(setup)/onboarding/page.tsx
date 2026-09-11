import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSimulation } from "@/lib/dev/simulation";
import { loadFirstLookReport } from "@/lib/onboarding/first-look-report";
import { estimateFirstMonthTraffic } from "@/lib/onboarding/first-month-outlook";
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
  const quotaRead = authRead.then(({ accountId, user }) => getRequestQuota(accountId, user.email ?? null));
  const simulation = await getSimulation();
  const [{ data: workspace }, { data: output }, quota, run, auth] = await Promise.all([
    supabase
      .from("workspaces")
      // The account's answer rides along on the workspace's own account row,
      // so the question is asked of the account that owns this site, once, and
      // not again for its second site.
      .select("id, domain, business_profile, sitemap_url, blog_root_url, example_article_urls, auto_generate_weekly_limit, auto_approve, onboarded_at, onboarding_skipped_at, accounts(attribution_source)")
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
  const account = workspace.accounts as { attribution_source: string | null } | { attribution_source: string | null }[] | null;
  const answered = Boolean((Array.isArray(account) ? account[0] : account)?.attribution_source);

  // What the gate screen shows behind its lock: the month this account
  // already had planned for it, and the analysis already run on its site.
  // Both are read only when the gate is the screen being rendered - there is
  // no point paying for them on the way into the wizard.
  const gateShown =
    Boolean(workspace.onboarded_at || workspace.onboarding_skipped_at) &&
    (simulation?.gate === true || (quota.reason === "no-plan" && Boolean(quota.trialEligible)));
  const [gatePlan, gateReport, gateKeywords, gateWritten, gateAuthority] = gateShown
    ? await Promise.all([
        supabase
          .from("calendar_entries")
          .select("keyword, scheduled_date")
          .eq("workspace_id", workspace.id)
          .order("scheduled_date", { ascending: true })
          .limit(30)
          .then(({ data }) =>
            (data ?? [])
              .filter((r) => r.keyword && r.scheduled_date)
              .map((r) => ({ term: r.keyword as string, date: r.scheduled_date as string })),
          ),
        loadFirstLookReport(supabase, workspace.id).catch(() => null),
        // Volume and difficulty for what is planned: already priced during the
        // run, so the estimate costs nothing and cannot disagree with the
        // numbers the keywords page shows for the same terms.
        supabase
          .from("keywords")
          .select("volume, difficulty, status")
          .eq("workspace_id", workspace.id)
          .eq("status", "planned")
          .then(({ data }) => (data ?? []).map((r) => ({ volume: r.volume as number | null, difficulty: r.difficulty as number | null }))),
        // The articles the run already wrote, so the schedule can show the
        // first one as the finished thing it is rather than as another locked
        // row. Newest first and bounded: ordered the other way, a workspace
        // with any history at all returns its OLDEST articles, none of which
        // are in the month being shown, and every row renders locked.
        supabase
          .from("articles")
          .select("keyword, title, word_count, status, created_at")
          .eq("workspace_id", workspace.id)
          .order("created_at", { ascending: false })
          .limit(40)
          .then(({ data }) =>
            (data ?? []).map((r) => ({
              keyword: (r.keyword as string | null) ?? "",
              title: (r.title as string | null) ?? "",
              wordCount: (r.word_count as number | null) ?? 0,
            })),
          ),
        supabase
          .from("workspace_metrics")
          .select("authority")
          .eq("workspace_id", workspace.id)
          .order("measured_on", { ascending: false })
          .limit(1)
          .then(({ data }) => (data?.[0]?.authority ?? null) as number | null),
      ])
    : [[], null, [], [], null];
  const gateTraffic = gateShown ? estimateFirstMonthTraffic(gateKeywords, gateAuthority) : null;

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
      // `simulation.gate` is dev-only and forces this on too. Without it the
      // dashboard's forced redirect lands here and renders the WIZARD: a dev
      // install has no Stripe key, so the real quota says "self-host" and the
      // screen the redirect exists to show would never appear. In production
      // the two cannot disagree - trialGateApplies is only true when the
      // quota says exactly this.
      trialEligible={simulation?.gate === true || (quota.reason === "no-plan" && Boolean(quota.trialEligible))}
      initialProfile={(workspace.business_profile as BusinessProfile | null) ?? null}
      initialSite={{
        sitemapUrl: workspace.sitemap_url ?? "",
        blogRootUrl: workspace.blog_root_url ?? "",
        exampleArticleUrls: (workspace.example_article_urls as string[] | null) ?? [],
      }}
      initialOutput={initialOutput}
      askAttribution={!answered}
      initialStep={stepFromParam(step, SITE_STEPS.length + (answered ? 0 : 1))}
      // Already through setup once. The dashboard gate sends such a person
      // here for the card, and without this they would be handed the wizard
      // from its first screen - and "Finish" at the end of it starts a whole
      // new run: another site read, another keyword spend, a profile
      // overwritten with whatever the model proposes today.
      alreadyOnboarded={Boolean(workspace.onboarded_at || workspace.onboarding_skipped_at)}
      gatePlan={gatePlan}
      gateReport={gateReport}
      gateTraffic={gateTraffic}
      gateWritten={gateWritten}
      initialRun={run}
      initialAutoApprove={Boolean(workspace.auto_approve)}
    />
  );
}
