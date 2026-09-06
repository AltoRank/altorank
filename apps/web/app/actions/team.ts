"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { sendInviteEmail } from "@/lib/email/resend";
import { INVITABLE_ROLES, canEditMember, parseWorkspaceIds, type Role } from "@/lib/team/access";
import { z } from "zod";
import crypto from "node:crypto";

// Every action here is owner/admin only, checked on the server. The Team page
// hides the controls from editors as well, but hiding is presentation; these
// checks (and the policies in migration 053) are the rule.

const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(INVITABLE_ROLES as unknown as [string, ...string[]]).default("editor"),
});

/** The agency's own workspace ids, for validating what a form sends back. */
async function agencyWorkspaceIds(agencyId: string): Promise<string[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspaces").select("id").eq("agency_id", agencyId);
  return (data ?? []).map((w) => w.id as string);
}

export async function inviteMember(formData: FormData) {
  const { user, agencyId } = await requireAuth(["owner", "admin"]);

  const supabase = await createClient();
  const parsed = inviteMemberSchema.parse({
    email: formData.get("email"),
    role: formData.get("role") ?? undefined,
  });
  const workspaceIds = parseWorkspaceIds(formData.getAll("workspace_ids"), await agencyWorkspaceIds(agencyId));

  const { data: agency } = await supabase
    .from("agencies")
    .select("name")
    .eq("id", agencyId)
    .single();

  const inviterName = user.user_metadata?.full_name ?? user.email ?? "A team member";

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const { error: inviteError } = await supabase.from("invites").insert({
    agency_id: agencyId,
    email: parsed.email,
    role: parsed.role,
    workspace_ids: workspaceIds,
    token,
    invited_by: user.id,
    expires_at: expiresAt.toISOString(),
  });

  if (inviteError) throw new Error(inviteError.message);

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const acceptUrl = `${baseUrl}/invite/${token}`;

  try {
    await sendInviteEmail(
      parsed.email,
      inviterName,
      agency?.name ?? "your workspace",
      parsed.role,
      acceptUrl,
    );
  } catch {
    // Email send failure is non-fatal — the invite link still works
  }

  revalidatePath("/settings/team");
}

/** Take back a pending invite. The link stops working at once. */
export async function revokeInvite(inviteId: string) {
  const { agencyId } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("invites")
    .delete()
    .eq("id", inviteId)
    .eq("agency_id", agencyId)
    .is("accepted_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/team");
}

/** Load a member of the caller's agency, or throw. */
async function loadMember(memberId: string, agencyId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("agency_members")
    .select("id, user_id, role")
    .eq("id", memberId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (!data) throw new Error("That member is not on this account.");
  return { supabase, member: data as { id: string; user_id: string; role: string } };
}

/**
 * Change a member's role and which sites they see, together: the dialog
 * shows both, and saving one while the other silently reverted would be a
 * bug shaped exactly like the one the Team page is for.
 */
export async function updateMemberAccess(
  memberId: string,
  role: string,
  workspaceIds: unknown[],
) {
  const { user, agencyId, role: actorRole } = await requireAuth(["owner", "admin"]);
  const { supabase, member } = await loadMember(memberId, agencyId);

  if (!canEditMember({ userId: user.id, role: actorRole }, { userId: member.user_id, role: member.role })) {
    throw new Error("You cannot change this member.");
  }
  // Only an owner may make (or unmake) an owner.
  const nextRole: Role = (["owner", "admin", "editor"] as const).includes(role as Role) ? (role as Role) : "editor";
  if (nextRole === "owner" && actorRole !== "owner") throw new Error("Only an owner can make someone an owner.");

  const { error } = await supabase
    .from("agency_members")
    .update({
      role: nextRole,
      workspace_ids: parseWorkspaceIds(workspaceIds, await agencyWorkspaceIds(agencyId)),
    })
    .eq("id", memberId);

  if (error) throw new Error(error.message);
  revalidatePath("/settings/team");
}

/** Kept for callers that only change the role. */
export async function updateMemberRole(memberId: string, role: string) {
  const { agencyId } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();
  const { data: current } = await supabase
    .from("agency_members")
    .select("workspace_ids")
    .eq("id", memberId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  await updateMemberAccess(memberId, role, (current?.workspace_ids as string[] | null) ?? []);
}

export async function removeMember(memberId: string) {
  const { user, agencyId, role: actorRole } = await requireAuth(["owner", "admin"]);
  const { supabase, member } = await loadMember(memberId, agencyId);
  if (!canEditMember({ userId: user.id, role: actorRole }, { userId: member.user_id, role: member.role })) {
    throw new Error("You cannot remove this member.");
  }
  const { error } = await supabase.from("agency_members").delete().eq("id", memberId);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/team");
}
