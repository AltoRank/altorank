import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Accept Invitation" };

interface InvitePageProps {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const supabase = await createClient();

  // Look up the invite
  const { data: invite, error } = await supabase
    .from("invites")
    .select("*")
    .eq("token", token)
    .is("accepted_at", null)
    .single();

  if (error || !invite) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <h1 className="text-xl font-semibold mb-2">Invalid or expired invitation</h1>
        <p className="text-ink-3">This invite link is no longer valid.</p>
      </div>
    );
  }

  // Check if expired
  if (new Date(invite.expires_at) < new Date()) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <h1 className="text-xl font-semibold mb-2">Invitation expired</h1>
        <p className="text-ink-3">This invitation has expired. Ask your team admin for a new one.</p>
      </div>
    );
  }

  // Check if user is logged in
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Redirect to sign in with return URL
    redirect(`/signin?redirect=/invite/${token}`);
  }

  // Verify the logged-in user's email matches the invite
  if (user.email?.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <h1 className="text-xl font-semibold mb-2">Email mismatch</h1>
        <p className="text-ink-3">
          This invitation was sent to <strong>{invite.email}</strong>.
          Please sign in with that email address to accept it.
        </p>
      </div>
    );
  }

  // Accept the invite
  const { error: memberError } = await supabase.from("agency_members").insert({
    agency_id: invite.agency_id,
    user_id: user.id,
    role: invite.role,
  });

  if (memberError) {
    // Might already be a member
    if (memberError.code === "23505") {
      // Unique violation — already a member
      await supabase
        .from("invites")
        .update({ accepted_at: new Date().toISOString() })
        .eq("id", invite.id);

      redirect("/");
    }

    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
        <p className="text-ink-3">{memberError.message}</p>
      </div>
    );
  }

  // Mark invite as accepted
  await supabase
    .from("invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invite.id);

  redirect("/");
}
