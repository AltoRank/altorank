import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { AgencyMember, Invite } from "@/lib/types";
import type { ResolvedUser } from "@/lib/team/display";

export type MemberWithUser = AgencyMember & { user: ResolvedUser };

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
  const rows = (data ?? []) as AgencyMember[];

  // agency_members stores a user id and nothing else about the person, and
  // there is no profiles table: the email lives in auth.users, which the
  // session client cannot read. This type declared `user` from the start and
  // nothing ever filled it, so every row rendered as "Member" with an "M".
  // Resolved the way the rest of the app reaches auth.users (impersonation,
  // admin/users): the service role, one lookup per member. Teams are a handful
  // of people, so the fan-out is bounded; a lookup that fails leaves `user`
  // null and the page says "Unknown member" rather than guessing.
  const admin = createServiceClient();
  const users = await Promise.all(
    rows.map(async (m): Promise<ResolvedUser> => {
      try {
        const { data: found, error: lookupError } = await admin.auth.admin.getUserById(m.user_id);
        const u = found?.user;
        if (lookupError || !u?.email) return null;
        return { email: u.email, raw_user_meta_data: u.user_metadata ?? {} };
      } catch {
        return null;
      }
    }),
  );
  return rows.map((m, i) => ({ ...m, user: users[i] }));
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
