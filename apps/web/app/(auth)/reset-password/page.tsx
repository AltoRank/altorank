import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { sendPasswordReset } from "@/lib/email/auth-emails";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";

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

  // Sent by us (lib/email/auth-emails.ts), not by Supabase's mailer, so the
  // template lives in the repo. The link goes to /callback?token_hash=…, which
  // verifies it server-side; no cookie or PKCE verifier is needed, so the
  // link works in whichever browser opens it. Silent when the address has no
  // account: the message below is the same either way.
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  // Rate-limited and failed requests get that same banner too, so the form
  // cannot be used to probe for accounts. The truth goes to the server log
  // instead; before this, a dropped or refused request left no trace anywhere
  // (2026-09-02).
  const who = maskEmail(email);
  if (!checkToolRateLimit("password-reset", `${ip}:${email.toLowerCase()}`, 3, 15 * 60 * 1000)) {
    console.warn(`[reset-password] rate-limited ${who} from ${ip}: 3 requests per 15 minutes`);
  } else {
    try {
      const sent = await sendPasswordReset(email);
      if (!sent) console.info(`[reset-password] no account for ${who}; nothing sent`);
    } catch (e) {
      console.error(`[reset-password] ${who}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  redirect("/reset-password?sent=1");
}

/** `m***@example.com`: enough to match a support request, without a full address in the log. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
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
