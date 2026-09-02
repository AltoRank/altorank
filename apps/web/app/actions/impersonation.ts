"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/auth/operators";
import {
  decodeStash,
  encodeStash,
  sessionIdOf,
  IMPERSONATION_COOKIE,
  IMPERSONATION_MAX_AGE_S,
} from "@/lib/auth/impersonation-stash";

/**
 * View the product as another account, and come back.
 *
 * Both directions are one mechanism. Mint a one-time sign-in link for an
 * address with the service role (`auth.admin.generateLink`, the same call the
 * auth emails use; no email leaves), verify it on the cookie client, and the
 * browser now holds that account's session. Starting does it for the customer;
 * stopping does it for the operator. Nothing is re-typed and no password is
 * involved, so it is "without logging out" in the sense that matters: one
 * click each way, and the operator never sees a sign-in form.
 *
 * The session left behind is revoked server-side each time. After the swap
 * nothing holds its tokens, and a live session nobody can reach is the kind of
 * loose end that reads as a hole in an audit even when it is not one.
 *
 * Every start writes an admin_impersonations row before anything is minted,
 * and stop closes it. The customer's data is visible and editable exactly as
 * it is to them: this is not a read-only view, and the log is what makes that
 * acceptable.
 *
 * Errors come back as state rather than being thrown. A thrown server-action
 * error reaches production as "an error occurred" with the message stripped,
 * which is the one thing an operator halfway through a swap must not see.
 */
export type ImpersonationState = { error: string } | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: IMPERSONATION_MAX_AGE_S,
  };
}

async function closeLog(admin: SupabaseClient, logId: string | null, reason: string) {
  if (!logId) return;
  await admin
    .from("admin_impersonations")
    .update({ ended_at: new Date().toISOString(), end_reason: reason })
    .eq("id", logId);
}

export async function startImpersonation(
  _prev: ImpersonationState,
  formData: FormData,
): Promise<ImpersonationState> {
  const targetId = String(formData.get("userId") ?? "");
  if (!UUID.test(targetId)) return { error: "That is not a user id." };

  const supabase = await createClient();
  const {
    data: { user: operator },
  } = await supabase.auth.getUser();
  if (!operator?.email || !isAdminEmail(operator.email)) {
    return { error: "Only an operator can view as another account." };
  }
  if (operator.id === targetId) return { error: "That is your own account." };

  // Inside an impersonation the session is the customer's, so the operator
  // check above already fails and this is unreachable in practice. Kept
  // explicit: an operator viewing as another operator would be the one way to
  // lose track of who to become again.
  const jar = await cookies();
  const existing = decodeStash(jar.get(IMPERSONATION_COOKIE)?.value);
  if (existing && existing.target.id === operator.id) {
    return { error: "Stop the current view first." };
  }

  const admin = createServiceClient();
  const { data: found, error: findError } = await admin.auth.admin.getUserById(targetId);
  const target = found?.user;
  if (findError || !target?.email) {
    return { error: "No account with that id, or it has no email address." };
  }
  if (!target.email_confirmed_at) {
    // Verifying a sign-in link confirms the address as a side effect. That
    // would be us confirming an email on the customer's behalf, so it is not
    // offered; the row says "unconfirmed" and this says why.
    return { error: "That address is not confirmed. Opening it would confirm it on their behalf." };
  }
  if (target.banned_until && new Date(target.banned_until) > new Date()) {
    return { error: "That account is banned." };
  }

  // The row first. If the swap then fails, the attempt is still on record,
  // with why.
  const { data: log } = await admin
    .from("admin_impersonations")
    .insert({
      operator_user_id: operator.id,
      operator_email: operator.email,
      target_user_id: target.id,
      target_email: target.email,
    })
    .select("id")
    .single();
  const logId: string | null = log?.id ?? null;

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: target.email,
  });
  if (linkError || !link?.properties?.hashed_token) {
    const why = linkError?.message ?? "no token returned";
    await closeLog(admin, logId, `mint failed: ${why}`);
    return { error: `Could not open that account: ${why}.` };
  }

  // The operator's current session, read before verifyOtp replaces it: its
  // access token is what revokes it afterwards, and the pair restores it if
  // the swap has to be unwound.
  const {
    data: { session: before },
  } = await supabase.auth.getSession();

  const { data: verified, error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  if (verifyError || !verified.session) {
    const why = verifyError?.message ?? "no session returned";
    await closeLog(admin, logId, `verify failed: ${why}`);
    return { error: `Could not open that account: ${why}.` };
  }

  const sessionId = sessionIdOf(verified.session.access_token);
  if (!sessionId) {
    // Cannot bind the cookie to the session, so do not leave the swap half
    // done: revoke what was minted and put the operator's own session back.
    await admin.auth.admin.signOut(verified.session.access_token, "local");
    if (before) {
      await supabase.auth.setSession({
        access_token: before.access_token,
        refresh_token: before.refresh_token,
      });
    }
    await closeLog(admin, logId, "minted token carried no session_id");
    return { error: "The minted session carried no session id, so nothing was changed." };
  }

  jar.set(
    IMPERSONATION_COOKIE,
    encodeStash({
      v: 1,
      operator: { id: operator.id, email: operator.email },
      target: { id: target.id, email: target.email },
      sessionId,
      startedAt: new Date().toISOString(),
      logId,
    }),
    cookieOptions(),
  );

  // The browser has moved on, so the operator's own session is unreachable
  // from anywhere: end it. Best effort; a failure here leaves a dormant
  // session, not a broken swap.
  if (before?.access_token) {
    await admin.auth.admin.signOut(before.access_token, "local");
  }

  redirect("/dashboard");
}

export async function stopImpersonation(): Promise<ImpersonationState> {
  const jar = await cookies();
  const stash = decodeStash(jar.get(IMPERSONATION_COOKIE)?.value);
  if (!stash) {
    jar.delete(IMPERSONATION_COOKIE);
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const { data: claimsResult } = await supabase.auth.getClaims();
  const claims = claimsResult?.claims;
  if (!claims || claims.sub !== stash.target.id || claims.session_id !== stash.sessionId) {
    // Not the session this stash was issued for, so there is nothing to
    // return to from here. Drop the marker and let whoever is signed in carry
    // on as themselves.
    jar.delete(IMPERSONATION_COOKIE);
    redirect("/dashboard");
  }

  const admin = createServiceClient();
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: stash.operator.email,
  });
  if (linkError || !link?.properties?.hashed_token) {
    return {
      error: `Could not restore your session (${linkError?.message ?? "no token returned"}). You are still viewing as ${stash.target.email}; signing out always works.`,
    };
  }

  // The customer's minted session, read before verifyOtp replaces it, so it
  // can be revoked once the operator is back.
  const {
    data: { session: minted },
  } = await supabase.auth.getSession();

  const { data: verified, error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  if (verifyError || !verified.session) {
    return {
      error: `Could not restore your session (${verifyError?.message ?? "no session returned"}). You are still viewing as ${stash.target.email}; signing out always works.`,
    };
  }

  jar.delete(IMPERSONATION_COOKIE);
  if (minted?.access_token) {
    await admin.auth.admin.signOut(minted.access_token, "local");
  }
  await closeLog(admin, stash.logId, "stopped");

  redirect("/admin/users");
}
