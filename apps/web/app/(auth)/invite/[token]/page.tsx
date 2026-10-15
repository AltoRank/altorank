import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  AFTER_INVITE_ACCEPTED,
  inviteJoinPath,
  inviteSignInPath,
  lookupOpenInvite,
} from "@/lib/team/invite";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Accept Invitation" };

interface InvitePageProps {
  params: Promise<{ token: string }>;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8">
      <h1 className="text-xl font-semibold mb-2">{title}</h1>
      <p className="text-ink-3">{children}</p>
    </div>
  );
}

/**
 * Accepting an invite.
 *
 * The invitee is, by definition, not yet a member, so no member-scoped policy
 * can show them the invite row or let them insert their own membership. The
 * first version read and wrote through the cookie client and therefore
 * failed at the first select for every genuinely new user. This one reads
 * the invite with the service role, checks the signed-in email against it
 * ourselves, and writes the membership - with the invite's role and workspace
 * access - with the service role too. The token is the credential; the email
 * match is the check.
 *
 * Signed out, it offers the two ways in rather than bouncing to sign-in: an
 * invitee with no login yet creates one on the join page (lib/team/invite.ts).
 */
export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const supabase = await createClient();
  const admin = createServiceClient();

  const lookup = await lookupOpenInvite(admin, token);

  if (lookup.status === "invalid") {
    return <Notice title="Invalid or expired invitation">This invite link is no longer valid.</Notice>;
  }
  if (lookup.status === "expired") {
    return <Notice title="Invitation expired">This invitation has expired. Ask your team admin for a new one.</Notice>;
  }
  // Ownership is never handed out by email (migration 102 refuses such an
  // invite at the door); one written before that rule is not honoured here.
  if (lookup.status === "owner") {
    return <Notice title="Invitation not valid">This invitation asks for owner access, which is given on the Team page, not by email. Ask the account owner to invite you as an admin.</Notice>;
  }
  const { invite } = lookup;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {invite.accountName ? `Join ${invite.accountName}` : "Join your team"}
          </h1>
          <p className="mt-2 text-sm text-ink-3">
            This invitation is for <strong>{invite.email}</strong>.
          </p>
        </div>
        <div className="space-y-3">
          <Link
            href={inviteJoinPath(token)}
            className="block w-full text-center py-2.5 bg-accent text-white font-medium text-[13px] rounded-[7px] hover:bg-accent-2 transition-colors"
          >
            Create your login
          </Link>
          <Link
            href={inviteSignInPath(token)}
            className="block w-full text-center py-2.5 border border-line bg-bg text-ink font-medium text-[13px] rounded-[7px] hover:bg-panel transition-colors"
          >
            I already have a login
          </Link>
        </div>
      </div>
    );
  }

  if (user.email?.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <Notice title="Email mismatch">
        This invitation was sent to <strong>{invite.email}</strong>. Please sign in with that email address to
        accept it.
      </Notice>
    );
  }

  const { error: memberError } = await admin.from("account_members").insert({
    account_id: invite.account_id,
    user_id: user.id,
    role: invite.role,
    workspace_ids: invite.workspace_ids,
  });

  // 23505 is the unique (account_id, user_id): already a member. The invite is
  // still consumed so the link cannot be replayed.
  if (memberError && memberError.code !== "23505") {
    return <Notice title="Something went wrong">{memberError.message}</Notice>;
  }

  await admin.from("invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);

  // Not `/`: next.config.ts sends the root to the marketing site.
  redirect(AFTER_INVITE_ACCEPTED);
}
