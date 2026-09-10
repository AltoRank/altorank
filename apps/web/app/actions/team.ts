"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { sendInviteEmail } from "@/lib/email/resend";
import { appLink } from "@/lib/app-url";
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

/** The account's own workspace ids, for validating what a form sends back. */
async function accountWorkspaceIds(accountId: string): Promise<string[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspaces").select("id").eq("account_id", accountId);
  return (data ?? []).map((w) => w.id as string);
}

/**
 * What the caller has to know after an invite: the row exists either way, but
 * whether the person was actually told is a different fact.
 *
 * The toast used to read "Invite sent to X" whether or not the email left,
 * because the send was wrapped in a bare `catch {}`. A missing RESEND_API_KEY
 * or any Resend refusal produced a confident success and an invite nobody
 * knew about - the exact bug class lib/email/resend.ts documents having fixed
 * for password resets. The invite is still created, since the link works
 * whether or not the mail did; the caller is now told which happened, and the
 * pending row's Copy link button is the way out.
 */
export type InviteResult = {
  email: string;
  emailed: boolean;
  /** Why the email did not leave, for the toast and the server log. */
  emailError: string | null;
};

export async function inviteMember(formData: FormData): Promise<InviteResult> {
  const { user, accountId } = await requireAuth(["owner", "admin"]);

  const supabase = await createClient();
  const parsed = inviteMemberSchema.parse({
    email: formData.get("email"),
    role: formData.get("role") ?? undefined,
  });
  const workspaceIds = parseWorkspaceIds(formData.getAll("workspace_ids"), await accountWorkspaceIds(accountId));

  const { data: account } = await supabase
    .from("accounts")
    .select("name")
    .eq("id", accountId)
    .single();

  const inviterName = user.user_metadata?.full_name ?? user.email ?? "A team member";

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  /**
   * Pressing Invite twice for the same colleague means "send it again", not
   * "create a second invitation". It used to mean the second: `invites` was
   * unique on the token only, so a second click wrote a second row, sent a
   * second email, and listed the address twice on the Team page with two links
   * that both worked. Migration 073 adds the partial unique index that makes
   * this the only possible outcome.
   *
   * The pending row's token is reused, so a link already in their inbox keeps
   * working - re-inviting somebody must not silently break the link they were
   * sent yesterday. The role, the workspaces and the expiry are refreshed,
   * because those are what the person filling the form in again just chose.
   */
  const { data: pending } = await supabase
    .from("invites")
    .select("id, token")
    .eq("account_id", accountId)
    .ilike("email", parsed.email)
    .is("accepted_at", null)
    .maybeSingle();

  const token = (pending?.token as string | undefined) ?? crypto.randomBytes(32).toString("hex");

  const { error: inviteError } = pending
    ? await supabase
        .from("invites")
        .update({
          role: parsed.role,
          workspace_ids: workspaceIds,
          invited_by: user.id,
          expires_at: expiresAt.toISOString(),
        })
        .eq("id", pending.id)
    : await supabase.from("invites").insert({
        account_id: accountId,
        email: parsed.email,
        role: parsed.role,
        workspace_ids: workspaceIds,
        token,
        invited_by: user.id,
        expires_at: expiresAt.toISOString(),
      });

  if (inviteError) throw new Error(inviteError.message);

  const acceptUrl = appLink(`/invite/${token}`);

  // Non-fatal, but never silent: the invite row is already written and its
  // link works, so throwing would lose a valid invite over a mail problem.
  // Reported instead, so the UI can say "created, not sent".
  let emailed = true;
  let emailError: string | null = null;
  try {
    await sendInviteEmail(
      parsed.email,
      inviterName,
      account?.name ?? "your workspace",
      parsed.role,
      acceptUrl,
    );
  } catch (e) {
    emailed = false;
    emailError = e instanceof Error ? e.message : "The email could not be sent";
    console.error(`[invite] email to ${parsed.email} was refused: ${emailError}`);
  }

  revalidatePath("/settings/team");
  return { email: parsed.email, emailed, emailError };
}

/** Take back a pending invite. The link stops working at once. */
export async function revokeInvite(inviteId: string) {
  const { accountId } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("invites")
    .delete()
    .eq("id", inviteId)
    .eq("account_id", accountId)
    .is("accepted_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/team");
}

/** Load a member of the caller's account, or throw. */
async function loadMember(memberId: string, accountId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("account_members")
    .select("id, user_id, role")
    .eq("id", memberId)
    .eq("account_id", accountId)
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
  const { user, accountId, role: actorRole } = await requireAuth(["owner", "admin"]);
  const { supabase, member } = await loadMember(memberId, accountId);

  if (!canEditMember({ userId: user.id, role: actorRole }, { userId: member.user_id, role: member.role })) {
    throw new Error("You cannot change this member.");
  }
  // Only an owner may make (or unmake) an owner.
  const nextRole: Role = (["owner", "admin", "editor"] as const).includes(role as Role) ? (role as Role) : "editor";
  if (nextRole === "owner" && actorRole !== "owner") throw new Error("Only an owner can make someone an owner.");

  const { error } = await supabase
    .from("account_members")
    .update({
      role: nextRole,
      workspace_ids: parseWorkspaceIds(workspaceIds, await accountWorkspaceIds(accountId)),
    })
    .eq("id", memberId);

  if (error) throw new Error(error.message);
  revalidatePath("/settings/team");
}

/** Kept for callers that only change the role. */
export async function updateMemberRole(memberId: string, role: string) {
  const { accountId } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();
  const { data: current } = await supabase
    .from("account_members")
    .select("workspace_ids")
    .eq("id", memberId)
    .eq("account_id", accountId)
    .maybeSingle();
  await updateMemberAccess(memberId, role, (current?.workspace_ids as string[] | null) ?? []);
}

export async function removeMember(memberId: string) {
  const { user, accountId, role: actorRole } = await requireAuth(["owner", "admin"]);
  const { supabase, member } = await loadMember(memberId, accountId);
  if (!canEditMember({ userId: user.id, role: actorRole }, { userId: member.user_id, role: member.role })) {
    throw new Error("You cannot remove this member.");
  }
  const { error } = await supabase.from("account_members").delete().eq("id", memberId);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/team");
}
