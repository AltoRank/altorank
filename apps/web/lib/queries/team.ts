import { createClient } from "@/lib/supabase/server";
import type { AgencyMember, Invite } from "@/lib/types";

export type MemberWithUser = AgencyMember & {
  user: { email: string; raw_user_meta_data: Record<string, unknown> } | null;
};

export async function getAgencyMembers(): Promise<MemberWithUser[]> {
  const supabase = await createClient();

  // Get current user's agency
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: membership } = await supabase
    .from("agency_members")
    .select("agency_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) return [];

  const { data, error } = await supabase
    .from("agency_members")
    .select("*")
    .eq("agency_id", membership.agency_id)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as MemberWithUser[];
}

export async function getPendingInvites(): Promise<Invite[]> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: membership } = await supabase
    .from("agency_members")
    .select("agency_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) return [];

  const { data, error } = await supabase
    .from("invites")
    .select("*")
    .eq("agency_id", membership.agency_id)
    .is("accepted_at", null)
    // The invites table has no created_at - it never did - so this ordered by
    // a column that does not exist and the Team page has thrown since the
    // invites feature landed. Found the first time anyone actually loaded the
    // page rather than reading its code. expires_at is creation plus a fixed
    // TTL, so newest-first is the same order.
    .order("expires_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as Invite[];
}
