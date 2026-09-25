import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSimulation } from "@/lib/dev/simulation";
import { loadFirstLookReport } from "@/lib/onboarding/first-look-report";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { OnboardingWizard } from "@/components/onboarding/wizard";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { FREE_TIER_PACE } from "@/lib/content/pace";
import { requireAuth } from "@/lib/auth/require-auth";
import { getRequestQuota } from "@/lib/queries/quota";
import { latestRun } from "@/lib/onboarding/run-store";
import { heldTopics } from "@/lib/onboarding/plan";
import { trialGateState } from "@/lib/billing/trial";
import { loadFirstArticle } from "@/lib/onboarding/first-article";

export const metadata: Metadata = { title: "Set up your site" };

// Reading the site and asking a model about it happens inside a server action
// from this page; give it room.
export const maxDuration = 120;

/**
 * The wizard, for the scoped workspace.
 *
 * Scoped like every other page: the workspace comes from the switcher, not from
 * a query parameter, so a person with two sites sets up the one they are
 * looking at. A saved profile and site details are handed back in so
 * reopening the wizard edits rather than re-proposes. Article settings are
 * not asked here since 2026-09-11: they live in Settings with their defaults.
 */
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
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
  const [{ data: workspace }, quota, run, auth] = await Promise.all([
    supabase
      .from("workspaces")
      // The account's answer rides along on the workspace's own account row,
      // so the question is asked of the account that owns this site, once, and
      // not again for its second site.
      .select("id, domain, business_profile, sitemap_url, blog_root_url, example_article_urls, auto_generate_weekly_limit, auto_approve, onboarded_at, onboarding_skipped_at, accounts(attribution_source)")
      .eq("id", scopeId)
      .single(),
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

  // Whether this account sees the pre-trial view: the first article with no
  // preview and the card, instead of the plain finish. The same answer the
  // dashboard layout redirects on (lib/billing/trial.ts), so the kill switch
  // turns both off together. A bypassed address still sees it here - that is
  // what the bypass is for - and is let into the dashboard beside it.
  const preTrial =
    trialGateState(quota, auth.user.email ?? null, { simulated: simulation?.gate === true }) !== "open";

  // The workspace's first article, as its shape only. A fact about the site,
  // not about the latest run: read whenever the card could be on screen,
  // including at the end of a run in progress, which refreshes the page for it.
  const firstArticle = preTrial ? await loadFirstArticle(supabase, workspace.id, workspace.domain) : null;

  // What the gate screen shows behind its lock: the month this account
  // already had planned for it, and the analysis already run on its site.
  // Both are read only when the gate is the screen being rendered - there is
  // no point paying for them on the way into the wizard.
  const gateShown = Boolean(workspace.onboarded_at || workspace.onboarding_skipped_at) && preTrial;
  const [gatePlan, gateReport] = gateShown
    ? await Promise.all([
        supabase
          .from("calendar_entries")
          .select("keyword, scheduled_date, keywords(opportunity)")
          .eq("workspace_id", workspace.id)
          .order("scheduled_date", { ascending: true })
          .limit(30)
          .then(({ data }) =>
            (data ?? [])
              .filter((r) => r.keyword && r.scheduled_date)
              .map((r) => ({ term: r.keyword as string, date: r.scheduled_date as string, brief: ((Array.isArray(r.keywords) ? r.keywords[0] : r.keywords) as {opportunity?: import("@/lib/keyword-research/opportunity").Opportunity} | null)?.opportunity })),
          ),
        loadFirstLookReport(supabase, workspace.id).catch(() => null),
      ])
    : [[], null];
  // What the trial would open, beside the locked month: read only on the gate.
  const gateHeld = gateShown && gatePlan.length
    ? await heldTopics(supabase, workspace.id, workspace.auto_generate_weekly_limit ?? FREE_TIER_PACE, gatePlan.map((p) => p.date)).catch(() => null)
    : null;

  return (
    <>
    {status === "cancelled" && <p role="status" className="p-4 text-center text-sm">Checkout was cancelled. Nothing was charged, and your first article and plan are saved. Start the trial below whenever you are ready.</p>}
    <OnboardingWizard
      canBuy={auth.role === "owner"}
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
      // `simulation.gate` is dev-only and forces this on too, through the
      // same trialGateState the dashboard redirects on: a dev install has no
      // Stripe key, so the real quota says "self-host" and the screen the
      // redirect exists to show would never appear without it.
      trialEligible={preTrial}
      firstArticle={firstArticle?.article ?? null}
      firstArticleWriting={firstArticle?.writing ?? false}
      initialProfile={(workspace.business_profile as BusinessProfile | null) ?? null}
      initialSite={{
        sitemapUrl: workspace.sitemap_url ?? "",
        blogRootUrl: workspace.blog_root_url ?? "",
        exampleArticleUrls: (workspace.example_article_urls as string[] | null) ?? [],
      }}
      askAttribution={!answered}
      // Already through setup once. The dashboard gate sends such a person
      // here for the card, and without this they would be handed the wizard
      // from its first screen - and "Finish" at the end of it starts a whole
      // new run: another site read, another keyword spend, a profile
      // overwritten with whatever the model proposes today.
      alreadyOnboarded={Boolean(workspace.onboarded_at || workspace.onboarding_skipped_at)}
      gatePlan={gatePlan}
      gateHeld={gateHeld}
      gateReport={gateReport}
      initialRun={run}
    />
    </>
  );
}
