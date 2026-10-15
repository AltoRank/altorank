// ---------------------------------------------------------------------------
// The invite link, from the email to the dashboard
// ---------------------------------------------------------------------------
//
// An invite email carries `/invite/<token>`. Three people open it:
//
//   - somebody already signed in as the invited address: the page accepts
//     and sends them to the dashboard;
//   - somebody with a login who is signed out: they sign in with `next` set
//     back to the invite, and land on the same page signed in;
//   - somebody with no login at all: they create one at
//     `/invite/<token>/join`, which asks for a password and nothing else. No
//     account and no site are made for them, because they are joining one.
//     The confirmation link then returns them to the invite.
//
// Each of those used to end somewhere else. Sign-in read `next` and the page
// sent `redirect`, so the invite was dropped; the only way to get a login was
// the owner signup, which demands a domain and makes an account and a site of
// its own; and a successful accept redirected to `/`, which next.config.ts
// sends to the marketing site.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Where a teammate lands once the invite is accepted. Not `/`: that is the marketing site. */
export const AFTER_INVITE_ACCEPTED = "/dashboard";

/** The invite page itself, which is where every path below returns to. */
export function invitePath(token: string): string {
  return `/invite/${token}`;
}

/** Sign in, then come back to the invite. Sign-in reads `next` (lib/auth/next-path.ts). */
export function inviteSignInPath(token: string): string {
  return `/signin?${new URLSearchParams({ next: invitePath(token) })}`;
}

/** Create a login for the invited address, with no account or site of its own. */
export function inviteJoinPath(token: string): string {
  return `${invitePath(token)}/join`;
}

/**
 * The invite token in a sign-in `next`, or null. The sign-in page uses it so
 * that "Sign up" offers the invitee the join form rather than the owner
 * signup, which would make them an account and a site of their own.
 */
export function inviteTokenFromNext(next: string | null | undefined): string | null {
  const match = (next ?? "").match(/^\/invite\/([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

export interface OpenInvite {
  id: string;
  account_id: string;
  email: string;
  role: string;
  workspace_ids: string[] | null;
  expires_at: string;
  accountName: string | null;
}

export type InviteLookup =
  | { status: "open"; invite: OpenInvite }
  | { status: "invalid" }
  | { status: "expired" }
  /** Ownership is never handed out by email (migration 102); an older invite asking for it is refused. */
  | { status: "owner" };

/**
 * The unaccepted invite behind a token, read with the service role: the
 * person holding the link is by definition not a member yet, so no member
 * policy can show it to them. The token is the credential.
 */
export async function lookupOpenInvite(
  admin: SupabaseClient,
  token: string,
  now: Date = new Date(),
): Promise<InviteLookup> {
  if (!/^[A-Za-z0-9]+$/.test(token)) return { status: "invalid" };

  const { data: invite } = await admin
    .from("invites")
    .select("id, account_id, email, role, workspace_ids, expires_at")
    .eq("token", token)
    .is("accepted_at", null)
    .maybeSingle();

  if (!invite) return { status: "invalid" };
  if (new Date(invite.expires_at as string) < now) return { status: "expired" };
  if (invite.role === "owner") return { status: "owner" };

  const { data: account } = await admin
    .from("accounts")
    .select("name")
    .eq("id", invite.account_id as string)
    .maybeSingle();

  return {
    status: "open",
    invite: {
      ...(invite as Omit<OpenInvite, "accountName">),
      accountName: ((account?.name as string | undefined) ?? "").trim() || null,
    },
  };
}
