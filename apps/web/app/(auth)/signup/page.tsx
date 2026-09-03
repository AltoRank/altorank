import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { sendSignupConfirmation } from "@/lib/email/auth-emails";
import { authErrorMessage } from "@/lib/auth/errors";
import { generateIndexNowKey } from "@/lib/seo/indexing";
import { FREE_TIER_PACE } from "@/lib/content/pace";
import { normalizeDomain, DOMAIN_PATTERN } from "@/lib/growth-plan/build";

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

  // Create the auth user and send OUR confirmation email. `auth.signUp`
  // would make Supabase send its own from a dashboard template; this keeps
  // the email in the repo (lib/email/auth-emails.ts).
  let userId: string;
  try {
    userId = await sendSignupConfirmation({ email, password, name });
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
        // The free draft is delivered by the generate cron, which only
        // writes for opted-in workspaces. A workspace created at signup is
        // the opt-in: the person typed their domain to get exactly this.
        // Bounded by FREE_DRAFTS until they choose a plan, which is why the
        // pace is one a week and not more: the quota would refuse the rest.
        // The Stripe webhook raises it when they subscribe.
        auto_generate: true,
        auto_generate_weekly_limit: FREE_TIER_PACE,
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
            : "Add a domain and AltoRank sets up your workspace"}
        </p>
      </div>

      <form action={signUp} className="space-y-4">
        {prefilled && <input type="hidden" name="domain" value={prefilled} />}
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
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            Workspace name
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
        <button
          type="submit"
          className="w-full py-2.5 bg-accent text-white font-medium text-[13px] rounded-[7px] hover:bg-accent-2 transition-colors cursor-pointer"
        >
          Create account
        </button>
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
