import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
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
 */
export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const supabase = await createClient();
  const admin = createServiceClient();

  const { data: invite } = await admin
    .from("invites")
    .select("id, agency_id, email, role, workspace_ids, expires_at")
    .eq("token", token)
    .is("accepted_at", null)
    .maybeSingle();

  if (!invite) {
    return <Notice title="Invalid or expired invitation">This invite link is no longer valid.</Notice>;
  }

  if (new Date(invite.expires_at) < new Date()) {
    return <Notice title="Invitation expired">This invitation has expired. Ask your team admin for a new one.</Notice>;
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/signin?redirect=/invite/${token}`);
  }

  if (user.email?.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <Notice title="Email mismatch">
        This invitation was sent to <strong>{invite.email}</strong>. Please sign in with that email address to
        accept it.
      </Notice>
    );
  }

  const { error: memberError } = await admin.from("agency_members").insert({
    agency_id: invite.agency_id,
    user_id: user.id,
    role: invite.role,
    workspace_ids: invite.workspace_ids,
  });

  // 23505 is the unique (agency_id, user_id): already a member. The invite is
  // still consumed so the link cannot be replayed.
  if (memberError && memberError.code !== "23505") {
    return <Notice title="Something went wrong">{memberError.message}</Notice>;
  }

  await admin.from("invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);

  redirect("/");
}
