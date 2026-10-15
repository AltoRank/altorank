import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { sendSignupConfirmation } from "@/lib/email/auth-emails";
import { sendWelcome } from "@/lib/auth/welcome";
import { PENDING_SIGNUP_COOKIE, normalizeCode } from "@/lib/auth/pending-signup";
import { SubmitButton } from "@/components/auth/submit-button";
import { CodeInput } from "@/components/auth/code-input";

export const metadata: Metadata = { title: "Check your email" };

/**
 * The second half of signup: the code from the confirmation email, typed in
 * the tab the person never left. Verifying it signs them in and confirms the
 * address in one step, exactly as the email's link does (app/(auth)/callback),
 * and goes straight on to onboarding. The link still works on another device.
 */
async function verify(formData: FormData) {
  "use server";
  const email = (await cookies()).get(PENDING_SIGNUP_COOKIE)?.value;
  if (!email) redirect("/signup?error=" + encodeURIComponent("That code page expired. Enter your email again for a new code."));
  const token = normalizeCode(formData.get("code"));
  if (!token) redirect("/signup/verify?error=" + encodeURIComponent("Enter the code from the email: six digits."));

  const supabase = await createClient();
  // `email` is the current name for a signup code; `signup` is the older one
  // some Supabase versions still expect. A wrong or expired code fails both.
  let { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) ({ data, error } = await supabase.auth.verifyOtp({ email, token, type: "signup" }));
  if (error || !data.user) {
    redirect("/signup/verify?error=" + encodeURIComponent("That code did not work. It may have expired: check the newest email, or send a new code."));
  }
  await sendWelcome(data.user.id);
  (await cookies()).delete({ name: PENDING_SIGNUP_COOKIE, path: "/signup" });
  redirect("/onboarding");
}

async function resend() {
  "use server";
  const email = (await cookies()).get(PENDING_SIGNUP_COOKIE)?.value;
  if (!email) redirect("/signup");
  try {
    await sendSignupConfirmation({ email, name: "", next: "/onboarding" });
  } catch {
    redirect("/signup/verify?error=" + encodeURIComponent("A new code could not be sent. Wait a minute and try again."));
  }
  redirect("/signup/verify?sent=1");
}

export default async function VerifySignupPage(props: { searchParams: Promise<{ error?: string; sent?: string }> }) {
  const { error, sent } = await props.searchParams;
  const email = (await cookies()).get(PENDING_SIGNUP_COOKIE)?.value;
  if (!email) redirect("/signup");

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 text-sm text-ink-3">
          We sent a code to <span className="font-medium text-ink-2">{email}</span>. Type it here and we start reading your site.
        </p>
      </div>
      <form action={verify} className="space-y-4">
        {error && (
          <div role="alert" className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
        {sent && !error && (
          <div role="status" className="text-sm text-accent-ink bg-accent-soft px-3 py-2 rounded-lg">
            A new code is on its way.
          </div>
        )}
        <CodeInput />
        <SubmitButton pendingLabel="Checking…">Continue</SubmitButton>
      </form>
      <form action={resend} className="text-center text-[12.5px] text-ink-3">
        Nothing yet? Check spam, or{" "}
        <button type="submit" className="text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink">
          send a new code
        </button>
        . <Link href="/signup" className="text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink">Use a different email</Link>
      </form>
    </div>
  );
}
