import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AuthFrame from "@/app/(auth)/layout";
import { addFirstSite } from "@/app/actions/first-site";
import { signOut } from "@/app/actions/auth";
import { SubmitButton } from "@/components/auth/submit-button";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { workingAccountId } from "@/lib/queries/account";
import { canAddWorkspace } from "@/lib/team/access";
import { normalizeDomain, DOMAIN_PATTERN } from "@/lib/domain/shape";

export const metadata: Metadata = { title: "Add your website" };

/**
 * The domain question, for a signed-in account with no site.
 *
 * Signup asks it first, so most accounts never see this page. One made any
 * other way arrived at /dashboard or /onboarding with nothing to set up, and
 * both now send it here rather than to the empty Sites table. In the signup
 * frame and with signup's words, because for this person it is the rest of
 * signup.
 *
 * Only for someone who can add the site: an owner or admin with every site.
 * A teammate limited to some sites, or an editor, cannot, and the Sites page
 * already says who can - so they go there, as before.
 */
export default async function FirstSitePage(props: {
  searchParams: Promise<{ error?: string; domain?: string }>;
}) {
  const searchParams = await props.searchParams;
  if (await getScopedWorkspaceId()) redirect("/onboarding");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const accountId = await workingAccountId(user);
  const { data: member } = await supabase
    .from("account_members")
    .select("role, workspace_ids")
    .eq("account_id", accountId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || !canAddWorkspace(member.role as string) || member.workspace_ids !== null) redirect("/workspaces");

  // Echoed only when it has a domain's shape, as on the signup form.
  const typed = normalizeDomain(searchParams?.domain ?? "");
  const prefilled = DOMAIN_PATTERN.test(typed) ? typed : "";

  return (
    <AuthFrame>
      <div className="space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">What&rsquo;s your website?</h1>
          <p className="mt-2 text-sm text-ink-3">
            We read it, plan your next month and write the first article. You read it before we ask for a card.
          </p>
        </div>

        <form action={addFirstSite} className="space-y-4">
          {searchParams?.error && (
            <div role="alert" className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">
              {searchParams.error}
            </div>
          )}
          <div>
            <label htmlFor="first-site-domain" className="text-[12.5px] font-medium text-ink-2 mb-1.5 block">
              Your website
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="first-site-domain"
                name="domain"
                type="text"
                required
                defaultValue={prefilled}
                inputMode="url"
                autoComplete="url"
                autoFocus
                aria-describedby="first-site-hint"
                className="w-full px-3 py-2.5 bg-bg border border-line rounded-[7px] text-base sm:text-[14px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
                placeholder="yourbusiness.com"
              />
              <SubmitButton
                pendingLabel="Checking…"
                className="shrink-0 py-2.5 px-4 bg-ink text-bg font-medium text-[14px] rounded-[7px] hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-60 disabled:cursor-progress"
              >
                Continue
              </SubmitButton>
            </div>
            <p id="first-site-hint" className="mt-1.5 text-[12px] text-ink-3">
              Nothing to install, and nothing publishes without your approval.
            </p>
          </div>
        </form>

        <form action={signOut} className="text-center text-sm text-ink-3">
          Signed in as {user.email}.{" "}
          <button type="submit" className="font-medium text-accent-ink hover:underline cursor-pointer">
            Sign out
          </button>
        </form>
      </div>
    </AuthFrame>
  );
}
