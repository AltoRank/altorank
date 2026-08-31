import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Reset password" };

/**
 * Found by walking the funnel: sign-in had no "forgot password" and no flow
 * behind one, so a locked-out account's only route back was a support email
 * to an inbox checked by hand. For a product onboarding design partners
 * tomorrow, that is a churn event on day one.
 */
async function requestReset(formData: FormData) {
  "use server";
  const email = (formData.get("email") as string)?.trim();
  if (!email) redirect("/reset-password?error=" + encodeURIComponent("Enter your email."));

  const supabase = await createClient();
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3100";

  /**
   * The redirect target is the bare Site URL on purpose.
   *
   * GoTrue only honours a redirect_to that matches its allowlist, and the
   * allowlist is dashboard state we do not control: on 2026-08-31 the
   * correct entry sat in the dashboard while the auth server clamped every
   * callback URL to the Site URL fallback anyway. The Site URL is the one
   * target that can never be clamped, because it IS the fallback.
   *
   * The recovery intent travels as a cookie instead of a query param. The
   * middleware forwards a stray ?code= on the root to /callback, and
   * /callback reads this cookie to pick the confirm page. A cookie adds no
   * new constraint: the PKCE verifier is already a cookie, so the link only
   * ever completes in the browser that asked.
   */
  const jar = await cookies();
  jar.set("pw_reset_pending", "1", {
    maxAge: 3600,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  await supabase.auth.resetPasswordForEmail(email, { redirectTo: origin });

  // Always the same answer, error or not. Confirming which addresses have
  // accounts is a user-enumeration gift; "if that account exists, mail is on
  // its way" is true in every case.
  redirect("/reset-password?sent=1");
}

export default async function ResetPasswordPage(props: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const searchParams = await props.searchParams;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p className="mt-2 text-sm text-ink-3">
          Enter your account email and we&rsquo;ll send a reset link
        </p>
      </div>

      <form action={requestReset} className="space-y-4">
        {searchParams?.sent && (
          <div className="text-sm text-accent-ink bg-accent-soft px-3 py-2 rounded-lg">
            If that account exists, a reset link is on its way. Check your inbox.
          </div>
        )}
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
        <button
          type="submit"
          className="w-full py-2.5 bg-accent text-white font-medium text-[13px] rounded-[7px] hover:bg-accent-2 transition-colors cursor-pointer"
        >
          Send reset link
        </button>
      </form>

      <p className="text-center text-sm text-ink-3">
        Remembered it?{" "}
        <Link href="/signin" className="font-medium text-accent-ink hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
