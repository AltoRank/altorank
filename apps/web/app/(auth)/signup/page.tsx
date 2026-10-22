import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { sendSignupConfirmation } from "@/lib/email/auth-emails";
import { authErrorMessage } from "@/lib/auth/errors";
import { firstSiteRow } from "@/lib/workspaces/first-site";
import { accountNameFromDomain } from "@/lib/domain/account-name";
import { normalizeDomain, DOMAIN_PATTERN } from "@/lib/growth-plan/build";
import { checkDomainReachable } from "@/lib/domain/reachable";
import { SignupSteps } from "@/components/auth/signup-steps";
import { PENDING_SIGNUP_COOKIE, PENDING_SIGNUP_MAX_AGE, TAKEN_SIGNUP_COOKIE, TAKEN_SIGNUP_MAX_AGE } from "@/lib/auth/pending-signup";
import { isAddressTaken } from "@/lib/auth/address-taken";
import { emailSignInCode } from "@/lib/auth/code-signin";
import { DEFAULT_AFTER_SIGN_IN } from "@/lib/auth/next-path";
import { CODE_NOT_SENT, signinPath } from "@/lib/auth/signin-path";
import { SubmitButton } from "@/components/auth/submit-button";
import { recordEvent } from "@/lib/observability/record";
import { existingSignup } from "@/lib/auth/signup-reuse";
import {
  describeSignupSource,
  parseSignupSource,
  signupSourceContext,
  signupSourceFields,
  signupSourceHref,
  signupSourceQuery,
  withRefererFallback,
} from "@/lib/auth/signup-source";

export const metadata: Metadata = {
  title: "Sign Up",
};

async function signUp(formData: FormData) {
  "use server";
  const email = formData.get("email") as string;
  // No password field since the code (/signup/verify): an empty value makes
  // the account with a random one nobody types.
  const password = ((formData.get("password") as string | null) ?? "") || undefined;
  // Where this signup came from (the marketing page, the referring site, the
  // campaign), carried in from the URL by hidden inputs. Every redirect back
  // to this form below takes it along, so a failed first submit keeps it; see
  // lib/auth/signup-source.ts.
  const source = parseSignupSource(formData);
  const carry = signupSourceQuery(source);
  const attribution = signupSourceContext(source);
  // Set when signup was reached from the homepage growth plan: the visitor has
  // already typed their domain once and seen a plan for it, so the first
  // workspace is created for that domain here rather than asked for again.
  const domain = normalizeDomain((formData.get("domain") as string | null) ?? "");
  // Without a workspace there is nothing to onboard, and the wizard would
  // bounce the new account to an empty "Your sites" page. Refuse up front.
  if (!DOMAIN_PATTERN.test(domain)) {
    redirect("/signup?error=" + encodeURIComponent("Enter your website as a domain, like acme.com.") + carry);
  }

  // The pattern above is shape only, and a name that resolves to nothing still
  // satisfies it. Signing up on one creates a workspace whose every later
  // phase - keywords, page check, plan, first draft - runs against a site that
  // is not there. Blocked here rather than discovered thirty articles later.
  // Only a name with no DNS at all is refused; see lib/domain/reachable.ts.
  const reach = await checkDomainReachable(domain);
  if (!reach.ok) {
    redirect("/signup?error=" + encodeURIComponent(reach.reason) + "&domain=" + encodeURIComponent(domain) + carry);
  }

  // The domain step on its own: the form asks one question at a time, and
  // before the page has hydrated (or without JavaScript) "Continue" submits
  // here with no email yet. The domain is checked, so a typo is caught before
  // anything else is asked, and the form comes back on the email.
  if (!email?.trim()) {
    redirect("/signup?domain=" + encodeURIComponent(domain) + carry);
  }

  // The account's name, from the domain, because asking for both is asking
  // the same question twice: nobody signs up as "Acme" from vitaminshop.de.
  // The wizard overwrites the BUSINESS name minutes later from what it reads
  // on the site, so this only has to hold the sidebar together until then.
  const name = accountNameFromDomain(domain) || domain;

  // Create the auth user and send OUR confirmation email. `auth.signUp`
  // would make Supabase send its own from a dashboard template; this keeps
  // the email in the repo (lib/email/auth-emails.ts). If the email cannot be
  // sent the user is deleted again there, so a retry is not "already
  // registered" with no link to confirm.
  let userId: string;
  try {
    userId = await sendSignupConfirmation({ email, password, next: "/onboarding" });
  } catch (e) {
    // A returning owner on the wrong form, most of them with no password
    // they know since code signup: offered a sign-in code to the address
    // they typed, which waits in a cookie rather than the URL.
    if (isAddressTaken(e)) {
      (await cookies()).set(TAKEN_SIGNUP_COOKIE, email.trim().toLowerCase(), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/signup",
        maxAge: TAKEN_SIGNUP_MAX_AGE,
      });
      redirect("/signup?taken=1" + carry);
    }
    redirect(
      "/signup?error=" +
        encodeURIComponent(authErrorMessage(e instanceof Error ? e.message : "Could not create the account")) +
        carry,
    );
  }
  const data = { user: { id: userId } };

  // Create the account record + membership using the service role (the user's
  // session is not confirmed yet).
  //
  // The table is called `accounts` and keeps that name: it is the tenant row,
  // and one of those holds a workspace per site or per client. The word only
  // has to be right where a person reads it, and "Could not create your
  // account" reads as a broken product to the solo founder the signup form is
  // now written for.
  if (data.user) {
    const admin = createServiceClient();
    const base =
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") ||
      "workspace";

    // `accounts.slug` is UNIQUE and the slug comes straight from the account
    // name, so the second person to sign up as "Acme" collided. The insert
    // error was discarded, leaving that user with an account but no account and
    // no membership. Retry with a suffix instead, and fail loudly if we still
    // cannot place them.
    let accountId: string | null = null;
    let lastError = "";

    // The same person submitting twice gets what the first submit made, not
    // a second account and a second site (lib/auth/signup-reuse.ts).
    const prior = await existingSignup(admin, data.user.id, DOMAIN_PATTERN.test(domain) ? domain : null);
    const alreadyMember = prior.accountId !== null;
    if (prior.accountId) accountId = prior.accountId;

    for (let attempt = 0; attempt < 5 && !accountId; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 8)}`;
      const { data: account, error: accountError } = await admin
        .from("accounts")
        .insert({ name, slug })
        .select("id")
        .single();

      if (account) {
        accountId = account.id;
        break;
      }
      lastError = accountError?.message ?? "unknown error";
      // 23505 is unique_violation: the slug is taken, so try another.
      if (accountError?.code !== "23505") break;
    }

    if (!accountId) {
      // Past this point the auth user exists and the account does not: the
      // person can sign in and lands nowhere. Every one of these three
      // branches leaves that half-made state behind, tells the visitor a
      // sentence and vanishes - there was no server-side trace at all, so an
      // abandoned signup and a broken one looked identical from here.
      //
      // Awaited, not fired and forgotten: `redirect` throws, and the write has
      // to have landed before it does.
      await recordEvent({
        level: "error",
        source: "signup",
        message: `The account row could not be created, so the user has no account: ${lastError}`,
        context: { stage: "account", userId: data.user.id, domain, ...attribution },
      });
      redirect("/signup?error=" + encodeURIComponent(`Could not set up your workspace: ${lastError}`) + carry);
    }

    const { error: memberError } = alreadyMember
      ? { error: null }
      : await admin.from("account_members").insert({
          account_id: accountId,
          user_id: data.user.id,
          role: "owner",
        });
    if (memberError) {
      await recordEvent({
        level: "error",
        source: "signup",
        message: `The membership could not be created, so the user cannot reach their own account: ${memberError.message}`,
        accountId,
        context: { stage: "member", userId: data.user.id, domain, ...attribution },
      });
      redirect(
        "/signup?error=" +
          encodeURIComponent(`Could not finish setting up your account: ${memberError.message}`) +
          carry,
      );
    }

    // The one success row a signup writes: the account and its owner exist.
    // It is what makes a channel gradeable, so it is written even when the
    // source is empty ("source unknown" is a finding too). A repeat submit
    // that reused the first one's account is not a second signup. It is the
    // only record of the source, so a prune of system_events keeps these rows
    // (supabase/migrations/RUNBOOK.md, 082).
    if (!alreadyMember) {
      await recordEvent({
        level: "info",
        source: "signup",
        message: `Account created, ${describeSignupSource(source)}`,
        accountId,
        context: { stage: "created", userId: data.user.id, domain, ...attribution },
      });
    }

    if (DOMAIN_PATTERN.test(domain) && !prior.workspaceId) {
      // The same row /onboarding/site writes (lib/workspaces/first-site.ts):
      // the opt-in to the free drafts, with automatic approval left off.
      const { error: wsError } = await admin.from("workspaces").insert({ account_id: accountId, ...firstSiteRow(domain) });
      // Not fatal: the account exists, and /dashboard sends an account with
      // no site to /onboarding/site, which asks for the domain again. Log it
      // so a silent miss here is findable - and record it, because
      // "findable" meant a Vercel function log nobody tails. This is the
      // branch that decides whether a new signup gets the first draft it was
      // promised.
      if (wsError) {
        console.error("[signup] workspace for", domain, wsError.message);
        await recordEvent({
          level: "warn",
          source: "signup",
          message: `The first site could not be created, so nothing will be written for this account yet: ${wsError.message}`,
          accountId,
          context: { stage: "workspace", userId: data.user.id, domain, ...attribution },
        });
      }
    }
  }

  // The code is in their inbox; the page that takes it knows the address
  // from a short-lived cookie rather than the URL, so the address is not in
  // history, logs or a Referer.
  (await cookies()).set(PENDING_SIGNUP_COOKIE, email, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/signup",
    maxAge: PENDING_SIGNUP_MAX_AGE,
  });
  redirect("/signup/verify");
}

/**
 * "Email me a sign-in code", for the address a signup was refused for
 * because it already has an account. The address comes from the cookie the
 * signup set, never from the form, so this cannot email anyone else.
 */
async function emailCodeToTakenAddress() {
  "use server";
  const jar = await cookies();
  const email = jar.get(TAKEN_SIGNUP_COOKIE)?.value;
  // The cookie ran out: /signin asks for the address again.
  if (!email) redirect("/signin");
  try {
    await emailSignInCode(email, DEFAULT_AFTER_SIGN_IN);
  } catch (e) {
    console.error(`[signup] sign-in code for a taken address failed: ${e instanceof Error ? e.message : String(e)}`);
    redirect(signinPath("/signin", null, { error: CODE_NOT_SENT }));
  }
  jar.delete({ name: TAKEN_SIGNUP_COOKIE, path: "/signup" });
  redirect(signinPath("/signin/code", null, { step: "code" }));
}

export default async function SignUpPage(props: {
  searchParams: Promise<{ error?: string; success?: string; domain?: string; taken?: string }>;
}) {
  const searchParams = await props.searchParams;
  const domain = normalizeDomain(searchParams?.domain ?? "");
  const prefilled = DOMAIN_PATTERN.test(domain) ? domain : null;
  // Read the same way the action reads them, so only values that pass the
  // shape checks are ever echoed into the form. A visitor who came straight
  // here (an AI answer's link, a bookmark) brings no `ref`, so the Referer
  // header's site stands in for it; an error redirect back here comes from
  // this page, which is not a source, and keeps the one it carried.
  const requestHeaders = await headers();
  const source = withRefererFallback(
    parseSignupSource(searchParams),
    requestHeaders.get("referer"),
    requestHeaders.get("host"),
  );
  const sourceFields = signupSourceFields(source);

  if (searchParams?.taken) {
    const taken = (await cookies()).get(TAKEN_SIGNUP_COOKIE)?.value ?? null;
    // Another address starts the form again, still carrying where it came from.
    const again = "/signup" + signupSourceQuery(source).replace(/^&/, "?");
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        </div>
        <div role="alert" className="text-sm text-accent-ink bg-accent-soft px-3 py-2 rounded-lg">
          {taken ? (
            <>
              You already have an account with <span className="font-medium">{taken}</span>. We can email you a sign-in code.
            </>
          ) : (
            "You already have an account with this address. We can email you a sign-in code."
          )}
        </div>
        <form action={emailCodeToTakenAddress}>
          <SubmitButton pendingLabel="Sending…">Email me a sign-in code</SubmitButton>
        </form>
        <p className="text-center text-[12.5px] text-ink-3">
          <Link href="/signin?method=password" className="text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink">
            Use a password instead
          </Link>
          {" · "}
          <Link href={again} className="text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink">
            Sign up with another address
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Read your first article before you start a trial</h1>
        <p className="mt-2 text-sm text-ink-3">
          {prefilled
            ? `We read ${prefilled}, plan your next month and write the first article. You read it before we ask for a card.`
            : "Paste your website. We read it, plan your next month and write the first article. You read it before we ask for a card."}
        </p>
      </div>

      <form action={signUp} className="space-y-4">
        {sourceFields.map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {searchParams?.success && (
          <div className="text-sm text-accent-ink bg-accent-soft px-3 py-2 rounded-lg">
            {searchParams.success}
          </div>
        )}
        {searchParams?.error && (
          <div role="alert" className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">
            {searchParams.error}
          </div>
        )}
        {/* The domain, then the email, then a code typed on the next page:
            no password, and no leaving the tab to click a link. */}
        <SignupSteps prefilledDomain={prefilled} startOnDomain={Boolean(searchParams?.error)} />
      </form>

      <p className="text-center text-sm text-ink-3">
        Already have an account?{" "}
        <Link href={signupSourceHref("/signin", source)} className="font-medium text-accent-ink hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
