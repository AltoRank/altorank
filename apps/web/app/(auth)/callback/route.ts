import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { sendWelcome } from "@/lib/auth/welcome";
import { safeNextPath } from "@/lib/auth/next-path";
import { EXPIRED_LINK_MESSAGE, signinPath } from "@/lib/auth/signin-path";
import { recordSignIn } from "@/lib/auth/signin-event";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Two ways in.
 *
 * `?token_hash=&type=` is the link in the emails we send ourselves
 * (lib/email/auth-emails.ts): the hash is verified here, server-side, and
 * the session is set. It needs no cookie from the requesting browser, so the
 * link works wherever it is opened.
 *
 * `?code=` is the PKCE code from OAuth and any legacy Supabase-sent link; it
 * is exchanged with the verifier cookie the browser holds.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const jar = await cookies();
  const resetPending = jar.get("pw_reset_pending")?.value === "1";
  // The same rule as every other `next` (lib/auth/next-path.ts). The old
  // pattern here refused any query, so the one-click link in the sign-in
  // code email dropped `/articles?status=review` for the dashboard.
  const requestedNext = safeNextPath(searchParams.get("next"));
  const next = requestedNext ?? (type === "recovery" || resetPending ? "/reset-password/confirm" : "/dashboard");

  const supabase = await createClient();

  if (tokenHash && type) {
    const { data: verified, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      // The welcome, sent here rather than at signup: the confirmation link is
      // already in their inbox, and a second email before they have clicked it
      // is two emails each saying to click the other one. `sendOnce` is keyed
      // by the user id, so re-opening the link does not send a second.
      // Not for a teammate confirming from an invitation (the link returns to
      // /invite/<token>): the welcome is about their own site and trial, and
      // they have neither.
      if (type === "signup" && verified.user && !next.startsWith("/invite/")) await sendWelcome(verified.user.id);
      if (type === "magiclink") await recordSignIn("link", verified.user?.id);
      return NextResponse.redirect(`${origin}${next}`);
    }
    // To the code form, still holding where the link was going: a code is
    // the way in that needs nothing the person may not have.
    return NextResponse.redirect(`${origin}${signinPath("/signin", requestedNext, { error: EXPIRED_LINK_MESSAGE })}`);
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const res = NextResponse.redirect(`${origin}${next}`);
      if (resetPending) res.cookies.delete("pw_reset_pending");
      return res;
    }
  }

  return NextResponse.redirect(`${origin}/signin?error=Could+not+authenticate`);
}
