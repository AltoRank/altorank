"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { sendInviteEmail } from "@/lib/email/resend";
import { z } from "zod";
import crypto from "node:crypto";

const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "editor"]).default("editor"),
});

export async function inviteMember(formData: FormData) {
  // Only owners and admins can invite new members
  const { user, agencyId } = await requireAuth(["owner", "admin"]);

  const supabase = await createClient();
  const parsed = inviteMemberSchema.parse({
    email: formData.get("email"),
    role: formData.get("role"),
  });

  // Get agency name and inviter name
  const { data: agency } = await supabase
    .from("agencies")
    .select("name")
    .eq("id", agencyId)
    .single();

  const inviterName = user.user_metadata?.full_name ?? user.email ?? "A team member";

  // Generate invite token
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  // Create invite record
  const { error: inviteError } = await supabase.from("invites").insert({
    agency_id: agencyId,
    email: parsed.email,
    role: parsed.role,
    token,
    invited_by: user.id,
    expires_at: expiresAt.toISOString(),
  });

  if (inviteError) throw new Error(inviteError.message);

  // Send invite email
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

export async function updateMemberRole(memberId: string, role: string) {
  await requireAuth(["owner", "admin"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("agency_members")
    .update({ role })
    .eq("id", memberId);

  if (error) throw new Error(error.message);
  revalidatePath("/settings/team");
}

export async function removeMember(memberId: string) {
  await requireAuth(["owner", "admin"]);
  const supabase = await createClient();
  const { error } = await supabase.from("agency_members").delete().eq("id", memberId);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/team");
}
