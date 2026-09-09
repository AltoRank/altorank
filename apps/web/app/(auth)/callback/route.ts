import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { notifyWelcome } from "@/lib/email/lifecycle";
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
    const { data: verified, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      // The welcome, sent here rather than at signup: the confirmation link is
      // already in their inbox, and a second email before they have clicked it
      // is two emails each saying to click the other one. `sendOnce` is keyed
      // by the user id, so re-opening the link does not send a second.
      if (type === "signup" && verified.user) await sendWelcome(verified.user.id);
      return NextResponse.redirect(`${origin}${next}`);
    }
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

/**
 * Never allowed to break the confirmation. The account is confirmed by the
 * time this runs, and a mail provider being down must not turn "you are in"
 * into "could not authenticate".
 */
async function sendWelcome(userId: string): Promise<void> {
  try {
    const admin = createServiceClient();
    const { data: member } = await admin
      .from("account_members")
      .select("account_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    // The site they typed at signup, when there is one - it is what makes the
    // email about them rather than about the product.
    let domain: string | null = null;
    let name: string | null = null;
    if (member?.account_id) {
      const { data: workspace } = await admin
        .from("workspaces")
        .select("domain")
        .eq("account_id", member.account_id as string)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      domain = (workspace?.domain as string | null) ?? null;
    }
    const { data: user } = await admin.auth.admin.getUserById(userId);
    const meta = user?.user?.user_metadata as { name?: string; full_name?: string } | undefined;
    name = meta?.name?.trim() || meta?.full_name?.trim() || null;
    // A name field that holds an address is a name nobody wants read back.
    if (name?.includes("@")) name = null;

    await notifyWelcome(admin, userId, { name, domain });
  } catch (err) {
    console.error(`[callback] welcome email for ${userId}: ${err instanceof Error ? err.message : err}`);
  }
}
