import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import type { EmailOtpType } from "@supabase/supabase-js";

const SAFE_NEXT = /^\/[a-zA-Z0-9/_-]*$/;

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
  const requestedNext = searchParams.get("next");
  const next =
    requestedNext && SAFE_NEXT.test(requestedNext)
      ? requestedNext
      : type === "recovery" || resetPending
        ? "/reset-password/confirm"
        : "/dashboard";

  const supabase = await createClient();

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    return NextResponse.redirect(
      `${origin}/signin?error=${encodeURIComponent("That link has expired or was already used. Request a new one.")}`,
    );
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
