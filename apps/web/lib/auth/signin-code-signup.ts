// ---------------------------------------------------------------------------
// A signup that came in by "Email me a sign-in code"
// ---------------------------------------------------------------------------
//
// Supabase creates the user when a sign-in code is asked for an address that
// has none (lib/email/auth-emails.ts, sendSignInCode). That made the sign-in
// form a second signup door, and nothing treated it as one: no account until
// the membership fallback made one on the first page load, no `signup` event,
// no domain. A real signup came in that way on 2026-10-19, landed with no
// site and never added one.
//
// It is kept as a door, on purpose: a person who reaches sign-in without an
// account (from the plugin's connect flow, or who simply forgot) gets in. So
// it is made a signup here, as the signup form makes one before the address
// is confirmed: the account and its owner, and the event that counts it.
// The domain comes after the code, on /onboarding/site, which also renames
// the account after the site (app/actions/first-site.ts).

import { createServiceClient } from "@/lib/supabase/server";
import { createOwnedAccount } from "@/lib/queries/account";
import { recordEvent } from "@/lib/observability/record";

/** The `source` this door writes on its `signup` event. */
export const SIGNIN_CODE_SOURCE = "signin_code";

/**
 * Make the account for a user the sign-in code just created, and record the
 * signup. Never throws: the code is already on its way, and if this fails the
 * membership fallback still makes an account on the first page load (and
 * says so, lib/queries/account.ts). Returns the account id, or null.
 */
export async function startSigninCodeSignup(userId: string, email: string): Promise<string | null> {
  try {
    const admin = createServiceClient();
    // A second request before the first code was used reaches here only if
    // Supabase reported a signup again; the account the first one made stands.
    const { data: member, error } = await admin
      .from("account_members")
      .select("account_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`could not read the membership: ${error.message}`);
    if (member) return member.account_id as string;

    const accountId = await createOwnedAccount(userId, {}, email);
    await recordEvent({
      level: "info",
      source: "signup",
      message: "Account created, from the sign-in code (no signup form, so no site yet)",
      accountId,
      context: { stage: "created", userId, source: SIGNIN_CODE_SOURCE },
    });
    return accountId;
  } catch (e) {
    await recordEvent({
      level: "error",
      source: "signup",
      message: `The sign-in code made a user but its account could not be created: ${e instanceof Error ? e.message : String(e)}`,
      context: { stage: "account", userId, source: SIGNIN_CODE_SOURCE },
    });
    return null;
  }
}
