"use server";

// ---------------------------------------------------------------------------
// The sign-in actions, shared by /signin and /signin/code
// ---------------------------------------------------------------------------
//
// /signin asks for a code first and holds the password form one tap away;
// /signin/code is where the emailed code is typed. Both post here. `next` is
// validated on every hop (lib/auth/next-path.ts): it arrives in a URL.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authErrorMessage } from "@/lib/auth/errors";
import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from "@/lib/auth/next-path";
import { normalizeCode } from "@/lib/auth/pending-signup";
import { PENDING_SIGNIN_COOKIE } from "@/lib/auth/pending-signin";
import { emailSignInCode } from "@/lib/auth/code-signin";
import { CODE_NOT_SENT, signinPath } from "@/lib/auth/signin-path";
import { recordSignIn } from "@/lib/auth/signin-event";

/**
 * Sign in without a password: an email code, typed on /signin/code. The same
 * answer whether or not the address has an account, so the form cannot be
 * used to find out which ones do.
 */
export async function requestSignInCode(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = safeNextPath(formData.get("next"));
  if (!email.includes("@")) redirect(signinPath("/signin", next, { error: "Enter your email address." }));
  try {
    await emailSignInCode(email, next ?? DEFAULT_AFTER_SIGN_IN);
  } catch (e) {
    console.error(`[signin] code for an address failed: ${e instanceof Error ? e.message : String(e)}`);
    redirect(signinPath("/signin", next, { error: CODE_NOT_SENT }));
  }
  redirect(signinPath("/signin/code", next, { step: "code" }));
}

export async function verifySignInCode(formData: FormData) {
  const next = safeNextPath(formData.get("next"));
  const email = (await cookies()).get(PENDING_SIGNIN_COOKIE)?.value;
  if (!email) redirect(signinPath("/signin", next, { error: "That code page expired. Ask for a new code." }));
  const token = normalizeCode(formData.get("code"));
  if (!token) redirect(signinPath("/signin/code", next, { step: "code", error: "Enter the code from the email." }));
  const supabase = await createClient();
  let { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) ({ data, error } = await supabase.auth.verifyOtp({ email, token, type: "magiclink" }));
  if (error) redirect(signinPath("/signin/code", next, { step: "code", error: "That code did not work. It may have expired: ask for a new one." }));
  (await cookies()).delete({ name: PENDING_SIGNIN_COOKIE, path: "/signin" });
  await recordSignIn("code", data.user?.id);
  redirect(next ?? DEFAULT_AFTER_SIGN_IN);
}

export async function signInWithPassword(formData: FormData) {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  // Where the middleware was taking them before it stopped them here. Validated
  // rather than trusted: it arrives in a URL, and a redirect target read out of
  // a URL is an open redirect unless something refuses `//evil.com` and its
  // relatives (lib/auth/next-path.ts).
  const next = safeNextPath(formData.get("next"));
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Back on the password form, with `next`: a mistyped password must not
    // cost the reader the article the email was about.
    redirect(signinPath("/signin", next, { method: "password", error: authErrorMessage(error.message) }));
  }
  await recordSignIn("password", data.user?.id);
  redirect(next ?? DEFAULT_AFTER_SIGN_IN);
}
