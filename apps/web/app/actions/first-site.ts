"use server";

// ---------------------------------------------------------------------------
// The first site, for an account that reached the app without one
// ---------------------------------------------------------------------------
//
// Signup asks for the domain before anything else and makes the site with the
// account, so the wizard always had a site to set up. An account made any
// other way - the membership fallback in lib/queries/account.ts - had none,
// and /onboarding sent it to /workspaces: the agency table, empty, with "Add
// workspace above". A real signup landed there twice in one day and never
// added a site (2026-10-19). This is the domain question signup would have
// asked, and the row it would have written, then the wizard.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { fallbackAccountName, workingAccountId } from "@/lib/queries/account";
import { getScopedWorkspaceId, SCOPE_COOKIE } from "@/lib/workspace-scope";
import { normalizeDomain, DOMAIN_PATTERN } from "@/lib/domain/shape";
import { checkDomainReachable } from "@/lib/domain/reachable";
import { getWorkspaceAllowance, workspaceLimitMessage } from "@/lib/billing/workspaces";
import { insertWorkspaceAsServer } from "@/lib/workspaces/insert";
import { FIRST_SITE_PATH, firstSiteRow, nameAccountAfterSite } from "@/lib/workspaces/first-site";
import { recordOnboardingStep } from "@/lib/onboarding/step-events";

/** Back to the domain question with a sentence to show, the domain kept. */
function back(error: string, domain: string): never {
  const query = new URLSearchParams({ error, ...(domain ? { domain } : {}) });
  redirect(`${FIRST_SITE_PATH}?${query}`);
}

export async function addFirstSite(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/signin?next=${encodeURIComponent(FIRST_SITE_PATH)}`);

  // A second tab, or a back button after the first submit: the site exists,
  // so the wizard is where this person is going.
  if (await getScopedWorkspaceId()) redirect("/onboarding");

  const domain = normalizeDomain(String(formData.get("domain") ?? ""));
  if (!DOMAIN_PATTERN.test(domain)) back("Enter your website as a domain, like acme.com.", domain);

  // Only a name with no DNS at all is refused, as at signup: a real site
  // behind a WAF that turns us away must still get in (lib/domain/reachable.ts).
  const reach = await checkDomainReachable(domain);
  if (!reach.ok) back(reach.reason, domain);

  const accountId = await workingAccountId(user);

  // The allowance stands here as everywhere else a site is added: a site is a
  // first look, and the first look is spend.
  const allowance = await getWorkspaceAllowance(supabase, accountId, user.email);
  if (allowance.remaining !== null && allowance.remaining <= 0) back(workspaceLimitMessage(allowance), domain);

  // Owner or admin with every site, checked inside, as for any added site.
  const inserted = await insertWorkspaceAsServer(supabase, user.id, accountId, firstSiteRow(domain));
  if (!inserted.ok) back(inserted.error, domain);

  // An account made for a person, not a site (the sign-in code's signups, the
  // membership fallback) is still called after their email. Signup names it
  // after the domain; so does this, unless someone has renamed it since.
  await nameAccountAfterSite(accountId, fallbackAccountName(user.user_metadata ?? {}, user.email), domain);

  // The step the funnel was missing: without it this person's first event
  // was the wizard opening on a site with no record of where it came from.
  await recordOnboardingStep(createServiceClient(), {
    workspaceId: inserted.id,
    accountId,
    userId: user.id,
    step: "site_added",
  });

  // The switcher's cookie, so the wizard opens on the site just made rather
  // than relying on it being the only one.
  (await cookies()).set(SCOPE_COOKIE, inserted.id, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  redirect("/onboarding");
}
