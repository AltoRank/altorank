import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { createClient } from "@/lib/supabase/server";
import { OnboardingProvider } from "@/components/onboarding/onboarding-provider";
import { WorkspaceProvider } from "@/components/dashboard/workspace-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ensureAccount } from "@/lib/queries/account";
import { isAdminEmail } from "@/lib/auth/operators";
import { inCustomerPreview } from "@/lib/auth/preview";
import { getImpersonation } from "@/lib/auth/impersonation";
import { ImpersonationBanner } from "@/components/dashboard/impersonation-banner";
import { getCompletedOnboardingSteps } from "@/lib/queries/onboarding";
import { getRequestQuota } from "@/lib/queries/quota";
import { entitledToScheduledWork } from "@/lib/billing/quota";
import { usageLine } from "@/lib/billing/usage-line";
import { siteAllowanceFrom } from "@/lib/workspaces/allowance";
import { FeedbackWidget } from "@/components/dashboard/feedback-widget";
import { DevToolbar } from "@/components/dashboard/dev-toolbar";
import { getSimulation } from "@/lib/dev/simulation";
import { getOperatorPreview } from "@/lib/auth/preview";
import { PLAN_LABELS } from "@/lib/stripe";
import { PreviewBanner } from "@/components/dashboard/preview-banner";
import { PaymentFailedBanner } from "@/components/dashboard/payment-failed-banner";
import { RunFailedBanner } from "@/components/dashboard/run-failed-banner";
import { latestRun } from "@/lib/onboarding/run-store";
import { failedRunNotice } from "@/lib/onboarding/events";
import { canManageBilling } from "@/lib/team/access";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Scoped to the workspace the switcher is on, exactly like the Articles
  // page. Unscoped, the badge counted every workspace RLS allowed and read as
  // a lie next to a list showing fewer.
  const scopeId = await getScopedWorkspaceId();
  const supabase = await createClient();

  // Everything below that depends only on the scope goes out in one wave. The
  // layout renders on every dashboard load and on every router.refresh() a
  // planner dialog triggers, and it used to make its reads one after another:
  // a dozen round trips in a row, three of them to the auth server, before the
  // first byte of the sidebar. Only the account-scoped reads still have to wait,
  // and they wait once.
  // Links belong to a site, so the Backlinks entry appears for the site that
  // has them; the sidebar's article badge counts the same site's articles.
  const backlinksQuery = supabase
    .from("backlinks")
    .select("id", { count: "exact", head: true });
  const scopedBacklinks = scopeId ? backlinksQuery.eq("workspace_id", scopeId) : backlinksQuery;
  const articlesQuery = supabase
    .from("articles")
    .select("id", { count: "exact", head: true });
  const scopedArticles = scopeId ? articlesQuery.eq("workspace_id", scopeId) : articlesQuery;
  const [
    workspaces,
    // The sidebar badge is a count. It used to fetch every article row - body
    // included - to read `.length` off the result.
    { count: articleCount },
    cookieStore,
    // Non-null only while an operator is signed in as a customer. Everything
    // below this line then describes the customer, which is the point; the
    // banner is what says so.
    impersonation,
    {
      data: { user },
    },
    // Exchanges are not per site: `backlink_exchanges` is keyed by account on
    // both sides, so it stays counted across the account, which is what it
    // describes.
    { count: backlinkCount, error: backlinkError },
    { count: exchangeCount, error: exchangeError },
    initialSteps,
    simulation,
    preview,
    customerPreview,
    // The scoped site's last setup run, for the banner below: a run that
    // fell short used to be visible only on the screen that ran it.
    runSnapshot,
  ] = await Promise.all([
    getWorkspaces(),
    scopedArticles,
    cookies(),
    getImpersonation(),
    supabase.auth.getUser(),
    scopedBacklinks,
    supabase.from("backlink_exchanges").select("id", { count: "exact", head: true }),
    getCompletedOnboardingSteps(),
    getSimulation(),
    getOperatorPreview(),
    inCustomerPreview(),
    scopeId ? latestRun(supabase, scopeId) : Promise.resolve(null),
  ]);

  /**
   * A site nobody has set up yet goes to the wizard, not to a dashboard of
   * dashes. The gate is per workspace and it is two dates, so it releases the
   * moment the wizard finishes or is skipped, and never fires twice for a
   * second member of the same account.
   *
   * Read off the list already loaded: `getWorkspaces` selects every column,
   * so asking the database for this one row again was a second round trip for
   * data already in hand.
   */
  let wizardDone = true;
  if (scopeId) {
    const ws = workspaces.find((w) => w.id === scopeId) as
      | (typeof workspaces[number] & {
          business_profile?: unknown;
          onboarded_at?: string | null;
          onboarding_skipped_at?: string | null;
        })
      | undefined;
    if (ws && !ws.onboarded_at && !ws.onboarding_skipped_at) {
      wizardDone = false;
      if (!ws.business_profile) redirect("/onboarding");
    }
  }

  const meta = user?.user_metadata ?? {};

  // Only once the wizard is done: before that the person is on the run
  // screen itself, which says the same thing with more room.
  const scopedWorkspace = scopeId ? workspaces.find((w) => w.id === scopeId) : undefined;
  const runNotice = wizardDone ? failedRunNotice(runSnapshot) : null;

  const accountId = user ? await ensureAccount(user.id, meta, user.email) : null;

  /**
   * Real identity for the sidebar footer.
   *
   * The footer printed "User · Owner · 1 member" for every account that ever
   * signed in: the props had defaults and nothing passed them. A label that is
   * the same for everyone is not information. Name falls back to the email,
   * which is at least true; role and member count come from account_members.
   *
   * Metered usage for the sidebar bar rides in the same wave. Null limit
   * renders nothing: unmetered is not a number to fill a bar with. Computed
   * once per request and shared with the pages that gate on it
   * (lib/queries/quota.ts).
   */
  const [{ data: membership }, { count: memberCount }, quota] = await Promise.all([
    accountId && user
      ? supabase
          .from("account_members")
          .select("role")
          .eq("account_id", accountId)
          .eq("user_id", user.id)
          .single()
      : Promise.resolve({ data: null }),
    accountId
      ? supabase
          .from("account_members")
          .select("id", { count: "exact", head: true })
          .eq("account_id", accountId)
      : Promise.resolve({ count: null }),
    accountId ? getRequestQuota(accountId, user?.email ?? null) : Promise.resolve(null),
  ]);
  // Sites the plan allows, for the switcher's "+ Add site" row. Derived from
  // the quota above and the list already loaded rather than queried again;
  // `workspaces` is RLS-scoped to this account, so its length is the count.
  const siteAllowance = siteAllowanceFrom(quota, workspaces.length);

  const profileName = typeof meta.name === "string" ? meta.name : undefined;
  const userName = profileName || user?.email || "Account";
  const userInitials = (userName.match(/[A-Za-z0-9]/)?.[0] ?? "A").toUpperCase();
  const role = membership?.role ?? null;

  const initialWorkspaceId = cookieStore.get("active_workspace")?.value;

  /**
   * Nav entries for features that have nothing to show yet.
   *
   * Backlinks is the only one gated today, and the reason is specific rather
   * than tidiness: the exchange is a network-effects feature with zero
   * counterparties, so an account that opens it finds an empty table, four
   * zeroes and a "Request link" button that no one can answer. POSITIONING.md
   * settles this as "keep it, say nothing until there is a network".
   *
   * Counted, never hardcoded, and never sticky: the entry comes back on its
   * own the moment a single link or exchange row exists, so nobody has to
   * remember to switch it on. Every other nav item stays put even when empty,
   * because an empty Keywords page is how you get keywords.
   */

  // Operations is cross-account data, so it is hidden unless the signed-in
  // address is an operator. The page 404s independently: nav is presentation,
  // not a permission boundary.
  //
  // In dev, the simulation cookie can force the customer view (admin: false)
  // so what a customer sees is checkable without a second account. It can
  // only take the entry away: pretending to be an operator would render a nav
  // item whose page 404s on the real email check.
  //
  // Judged on the user already fetched above - the same session `isAdmin()`
  // would have fetched again - and null inside a customer preview for the
  // reason lib/auth/admin.ts gives: a preview that kept the entry would be a
  // lie in exactly the place someone would check it.
  const operator =
    simulation?.admin === false ? false : !customerPreview && isAdminEmail(user?.email);

  // Backlinks is hidden at zero links, and only at a *confirmed* zero. Both
  // counts are null when their read fails as well as when there is nothing to
  // count, and `?? 0` collapsed those into each other - so one failed count
  // deleted a working page from the sidebar. Unknown is not zero here either.
  const noBacklinksKnown =
    !backlinkError && !exchangeError && (backlinkCount ?? 0) === 0 && (exchangeCount ?? 0) === 0;
  const hiddenNav = noBacklinksKnown ? ["backlinks"] : [];
  if (!operator) hiddenNav.push("admin");

  /**
   * Setup progress (`initialSteps`, read in the first wave) is counted from
   * the tables rather than read from a flag.
   *
   * `meta.onboarding_steps` used to hold this, and the tour wrote to it: the
   * checklist ticked a step because someone read a tooltip, not because they
   * connected anything. See `getCompletedOnboardingSteps` for why that had to
   * go. `onboarding_dismissed` survives because it is genuinely a preference -
   * "stop popping this up" is a thing only the person can tell us.
   */
  // The wizard replaces the checklist for a site it has set up.
  const dismissed = Boolean(meta.onboarding_dismissed) || wizardDone;

  const content = (
    <TooltipProvider delayDuration={150}>
    <WorkspaceProvider workspaces={workspaces} initialId={initialWorkspaceId}>
      <div className="flex h-dvh min-h-[720px] flex-col">
      {/* Both bars can be up at once - an operator can be impersonating and
          previewing - and they stack rather than compete, because each says a
          different true thing about why the app is behaving oddly. */}
      {preview && <PreviewBanner plan={preview.plan ? PLAN_LABELS[preview.plan] : undefined} />}
      {/* A failing renewal, until the card works. Read off the quota already
          computed for the sidebar: the same account row decides both. */}
      {quota?.dunning && <PaymentFailedBanner dunning={quota.dunning} canManage={canManageBilling(role)} />}
      {/* The scoped site's setup run fell short and nothing came of it. Says
          why, in the run's own words, and offers the retry the run screen
          offers - because the person is here now, not there. */}
      {runNotice && scopeId && (
        <RunFailedBanner
          workspaceId={scopeId}
          siteLabel={scopedWorkspace?.domain ?? scopedWorkspace?.name ?? "this site"}
          notice={runNotice}
        />
      )}
      {impersonation && (
        <ImpersonationBanner
          operatorEmail={impersonation.operatorEmail}
          targetEmail={impersonation.targetEmail}
          startedAt={impersonation.startedAt}
        />
      )}
      {/* Below md the sidebar is a slide-over and its top bar stacks above
          the page; from md up it is the left column it always was. */}
      <div className="flex flex-1 min-h-0 flex-col md:grid md:grid-cols-[auto_1fr]">
        <Sidebar
          badges={{ articles: articleCount ?? 0 }}
          hidden={hiddenNav}
          userName={userName}
          userInitials={userInitials}
          userId={user?.id}
          userEmail={user?.email}
          userProfileName={profileName}
          memberCount={memberCount ?? undefined}
          role={role}
          quota={
            quota && quota.limit !== null
              ? {
                  // Same derivation as the Billing page's usage card: one
                  // function decides what the counter says, so the sidebar
                  // cannot disagree with the page it links to.
                  ...(({ figure, fraction }) => ({ figure, fraction: fraction ?? 0 }))(usageLine(quota)),
                  noPlan: quota.reason === "no-plan",
                  limit: quota.limit,
                }
              : null
          }
          siteAllowance={siteAllowance}
        />
        {/* No topbar. It held a breadcrumb that restated the h1 immediately
            below it, and its two live controls moved into the sidebar, where
            they survive being collapsed. `PageHead` now occupies that row and
            lines the page title up with the mark. */}
        <div className="flex flex-col min-h-0 min-w-0 overflow-x-hidden bg-bg">
          <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* banners */}
            {children}
          </main>
          <FeedbackWidget />
          {process.env.NODE_ENV === "development" && (
            <DevToolbar simulation={simulation} />
          )}
        </div>
      </div>
      </div>
    </WorkspaceProvider>
    </TooltipProvider>
  );

  // Always mounted, even when dismissed and even when every step is done. The
  // provider decides whether the panel is showing; the help control in the
  // topbar needs the context in order to bring it back. Returning `content`
  // bare, as this used to, made "Skip setup" a one-way door.
  return (
    <OnboardingProvider
      initialSteps={initialSteps}
      dismissed={dismissed}
      // No quota at all means no account yet, and so nothing to promise about.
      scheduledWork={quota ? entitledToScheduledWork(quota) : true}
    >
      {content}
    </OnboardingProvider>
  );
}
