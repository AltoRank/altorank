// ---------------------------------------------------------------------------
// Email someone a sign-in code, and remember where it went
// ---------------------------------------------------------------------------
//
// Shared by /signin's form (app/(auth)/signin/actions.ts) and the signup form
// when the address it was given already has an account (app/(auth)/signup).
// Server-only: it sets a cookie.

import { cookies } from "next/headers";
import { sendSignInCode } from "@/lib/email/auth-emails";
import { startSigninCodeSignup } from "@/lib/auth/signin-code-signup";
import type { SignupSource } from "@/lib/auth/signup-source";
import { PENDING_SIGNIN_COOKIE, PENDING_SIGNIN_MAX_AGE } from "@/lib/auth/pending-signin";

/**
 * Send the code, and set the cookie /signin/code reads the address from (not
 * the URL, so it stays out of history, logs and a Referer). Throws when the
 * code could not be sent; the cookie is set only once it was. `source` is
 * where the visitor came from, recorded if the code makes the account.
 */
export async function emailSignInCode(email: string, next: string, source: SignupSource = {}): Promise<void> {
  const { createdUserId } = await sendSignInCode(email, next);
  // An address with no user got one, made by Supabase to receive this code:
  // a signup by the sign-in door, counted and given its account here
  // (lib/auth/signin-code-signup.ts). The page says the same either way.
  if (createdUserId) await startSigninCodeSignup(createdUserId, email, source);
  (await cookies()).set(PENDING_SIGNIN_COOKIE, email, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/signin",
    maxAge: PENDING_SIGNIN_MAX_AGE,
  });
}
