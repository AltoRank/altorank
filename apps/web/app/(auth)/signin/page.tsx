import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authErrorMessage } from "@/lib/auth/errors";
import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from "@/lib/auth/next-path";
import { SubmitButton } from "@/components/auth/submit-button";
import { toolReturnPath, toolSlugFromReturnUrl } from "@/lib/public-tools/return-url";

export const metadata: Metadata = {
  title: "Sign In",
};

async function signIn(formData: FormData) {
  "use server";
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  // Where the middleware was taking them before it stopped them here. Validated
  // rather than trusted: it arrives in a URL, and a redirect target read out of
  // a URL is an open redirect unless something refuses `//evil.com` and its
  // relatives (lib/auth/next-path.ts).
  //
  // From a tool page on altorank.co the destination is `return_to` instead,
  // reduced to the tool's slug and sent through /tool-return/<slug>, which
  // rebuilds the page URL itself (lib/public-tools/return-url.ts). That trip
  // skips the dashboard, so onboarding does not intercept it.
  const returnTo = formData.get("return_to");
  const toolSlug = toolSlugFromReturnUrl(returnTo);
  const next = toolSlug ? toolReturnPath(toolSlug) : safeNextPath(formData.get("next"));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const back = new URLSearchParams({ error: authErrorMessage(error.message) });
    // Kept across a failed attempt, or a mistyped password costs the reader the
    // article the email was about.
    if (toolSlug) back.set("return_to", String(returnTo).trim());
    else if (next) back.set("next", next);
    redirect(`/signin?${back}`);
  }
  redirect(next ?? DEFAULT_AFTER_SIGN_IN);
}

export default async function SignInPage(props: {
  searchParams: Promise<{ error?: string; next?: string; return_to?: string }>;
}) {
  const searchParams = await props.searchParams;
  const toolSlug = toolSlugFromReturnUrl(searchParams?.return_to);
  const returnTo = toolSlug ? String(searchParams.return_to).trim() : null;
  const next = toolSlug ? null : safeNextPath(searchParams?.next);
  const signupHref = returnTo
    ? `/signup?${new URLSearchParams({ from: "tools", return_to: returnTo })}`
    : "/signup";

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-2 text-sm text-ink-3">
          {toolSlug ? "Sign in and you go straight back to the tool." : "Sign in to AltoRank"}
        </p>
      </div>

      <form action={signIn} className="space-y-4">
        {next && <input type="hidden" name="next" value={next} />}
        {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
        {searchParams?.error && (
          <div className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">
            {searchParams.error}
          </div>
        )}
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
          <div className="flex items-baseline justify-between mb-1.5">
            <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 block">
              Password
            </label>
            <Link
              href="/reset-password"
              className="text-[11.5px] text-ink-3 hover:text-ink"
            >
              Forgot it?
            </Link>
          </div>
          <input
            name="password"
            type="password"
            required
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
          />
        </div>
        <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      </form>

      <p className="text-center text-sm text-ink-3">
        Don&apos;t have an account?{" "}
        {/* No `next` here: signup ends at the confirm email and then the
            wizard, so carrying a destination through would promise a landing
            this flow does not make. The one exception is a tool page, whose
            signup is the account-only variant and does come back. */}
        <Link href={signupHref} className="font-medium text-accent-ink hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
