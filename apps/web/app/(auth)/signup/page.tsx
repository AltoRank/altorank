import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { sendSignupConfirmation } from "@/lib/email/auth-emails";
import { authErrorMessage } from "@/lib/auth/errors";
import { generateIndexNowKey } from "@/lib/seo/indexing";
import { FREE_TIER_PACE } from "@/lib/content/pace";
import { normalizeDomain, DOMAIN_PATTERN } from "@/lib/growth-plan/build";
import { checkDomainReachable } from "@/lib/domain/reachable";
import { SubmitButton } from "@/components/auth/submit-button";

export const metadata: Metadata = {
  title: "Sign Up",
};

async function signUp(formData: FormData) {
  "use server";
  const name = formData.get("name") as string;
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  // Set when signup was reached from the homepage growth plan: the visitor has
  // already typed their domain once and seen a plan for it, so the first
  // workspace is created for that domain here rather than asked for again.
  const domain = normalizeDomain((formData.get("domain") as string | null) ?? "");
  // Without a workspace there is nothing to onboard, and the wizard would
  // bounce the new account to an empty "Your sites" page. Refuse up front.
  if (!DOMAIN_PATTERN.test(domain)) {
    redirect("/signup?error=" + encodeURIComponent("Enter your website as a domain, like acme.com."));
  }

  // The pattern above is shape only, and a name that resolves to nothing still
  // satisfies it. Signing up on one creates a workspace whose every later
  // phase - keywords, page check, plan, first draft - runs against a site that
  // is not there. Blocked here rather than discovered thirty articles later.
  // Only a name with no DNS at all is refused; see lib/domain/reachable.ts.
  const reach = await checkDomainReachable(domain);
  if (!reach.ok) {
    redirect("/signup?error=" + encodeURIComponent(reach.reason) + "&domain=" + encodeURIComponent(domain));
  }

  // Create the auth user and send OUR confirmation email. `auth.signUp`
  // would make Supabase send its own from a dashboard template; this keeps
  // the email in the repo (lib/email/auth-emails.ts). If the email cannot be
  // sent the user is deleted again there, so a retry is not "already
  // registered" with no link to confirm.
  let userId: string;
  try {
    userId = await sendSignupConfirmation({ email, password, name, next: "/onboarding" });
  } catch (e) {
    redirect("/signup?error=" + encodeURIComponent(authErrorMessage(e instanceof Error ? e.message : "Could not create the account")));
  }
  const data = { user: { id: userId } };

  // Create the account record + membership using the service role (the user's
  // session is not confirmed yet).
  //
  // The table is called `agencies` and keeps that name: it is the tenant row,
  // and one of those holds a workspace per site or per client. The word only
  // has to be right where a person reads it, and "Could not create your
  // agency" reads as a broken product to the solo founder the signup form is
  // now written for.
  if (data.user) {
    const admin = createServiceClient();
    const base =
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") ||
      "workspace";

    // `agencies.slug` is UNIQUE and the slug comes straight from the agency
    // name, so the second person to sign up as "Acme" collided. The insert
    // error was discarded, leaving that user with an account but no agency and
    // no membership. Retry with a suffix instead, and fail loudly if we still
    // cannot place them.
    let agencyId: string | null = null;
    let lastError = "";

    for (let attempt = 0; attempt < 5 && !agencyId; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 8)}`;
      const { data: agency, error: agencyError } = await admin
        .from("agencies")
        .insert({ name, slug })
        .select("id")
        .single();

      if (agency) {
        agencyId = agency.id;
        break;
      }
      lastError = agencyError?.message ?? "unknown error";
      // 23505 is unique_violation: the slug is taken, so try another.
      if (agencyError?.code !== "23505") break;
    }

    if (!agencyId) {
      redirect("/signup?error=" + encodeURIComponent(`Could not set up your workspace: ${lastError}`));
    }

    const { error: memberError } = await admin.from("agency_members").insert({
      agency_id: agencyId,
      user_id: data.user.id,
      role: "owner",
    });
    if (memberError) {
      redirect(
        "/signup?error=" +
          encodeURIComponent(`Could not finish setting up your account: ${memberError.message}`),
      );
    }

    if (DOMAIN_PATTERN.test(domain)) {
      const { error: wsError } = await admin.from("workspaces").insert({
        agency_id: agencyId,
        name: domain,
        domain,
        initials: domain.slice(0, 2).toUpperCase(),
        color: "av-c1",
        indexnow_key: generateIndexNowKey(),
        // The free drafts are delivered by onboarding (the first, inline)
        // and the generate cron and fan-out (the rest), all of which only
        // write for opted-in workspaces. A workspace created at signup is
        // the opt-in: the person typed their domain to get exactly this.
        // Bounded by FREE_DRAFTS until they choose a plan; the pace is
        // FREE_TIER_PACE so the whole allowance lands inside the first week
        // rather than over seven of them. The Stripe webhook raises it to the
        // paid default when they subscribe.
        auto_generate: true,
        auto_generate_weekly_limit: FREE_TIER_PACE,
        // auto_approve is deliberately NOT set here, so the column default
        // (false, migration 079) stands. Signup was the only path that turned
        // it on: the migration defaults off, `createWorkspace` inherits that,
        // and the settings action only enables it when somebody ticks the box
        // and is recorded as having done so. Turning it on here recorded the
        // new user as having "set" a rule they were never shown, on the one
        // account least able to judge the drafts - and the product sells the
        // veto ("review ALWAYS", AGENTS.md), which the onboarding wizard
        // states as an ALWAYS ON card. Enabling it is a choice the person
        // makes in workspace settings, after they have read a draft.
      });
      // Not fatal: the account exists, and the dashboard asks for a domain if
      // there is no workspace. Log it so a silent miss here is findable.
      if (wsError) console.error("[signup] workspace for", domain, wsError.message);
    }
  }

  redirect("/signup?success=Check+your+email+to+confirm+your+account");
}

export default async function SignUpPage(props: {
  searchParams: Promise<{ error?: string; success?: string; domain?: string }>;
}) {
  const searchParams = await props.searchParams;
  const domain = normalizeDomain(searchParams?.domain ?? "");
  const prefilled = DOMAIN_PATTERN.test(domain) ? domain : null;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="mt-2 text-sm text-ink-3">
          {prefilled
            ? `Your workspace for ${prefilled} is set up the moment you sign up`
            : "One site to start. AltoRank reads it and plans your first month."}
        </p>
      </div>

      <form action={signUp} className="space-y-4">
        {searchParams?.success && (
          <div className="text-sm text-accent-ink bg-accent-soft px-3 py-2 rounded-lg">
            {searchParams.success}
          </div>
        )}
        {searchParams?.error && (
          <div className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">
            {searchParams.error}
          </div>
        )}
        <div>
          {/* Not "Workspace name". A workspace in this product is one site,
              and this field is not that: it names the account, which is what
              the sidebar and every invitation show, while the workspace is
              named after the domain typed below. Someone reading "Workspace
              name" above "Your website" is being asked the same question
              twice in words they have no reason to know. */}
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            Company name
          </label>
          <input
            name="name"
            type="text"
            required
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
            placeholder="Acme"
          />
        </div>
        <div>
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            Your website
          </label>
          <input
            name="domain"
            type="text"
            required
            defaultValue={prefilled ?? ""}
            inputMode="url"
            autoComplete="url"
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
            placeholder="acme.com"
          />
          {/* Half of this was the sub-heading again ("AltoRank reads it and
              plans your first month" / "We read it first, so setup is a check
              rather than a form"), two lines apart on the same screen. The
              half worth keeping is the promise the sub-heading does not make. */}
          <p className="mt-1.5 text-[11.5px] text-ink-3">Nothing publishes without your approval.</p>
        </div>
        <div>
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            Email
          </label>
          <input
            name="email"
            type="email"
            required
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            Password
          </label>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
          />
        </div>
        <SubmitButton pendingLabel="Creating your account…">Create account</SubmitButton>
      </form>

      <p className="text-center text-sm text-ink-3">
        Already have an account?{" "}
        <Link href="/signin" className="font-medium text-accent-ink hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
