import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * The account's owner: the auth user an approval from inside Shopify is
 * recorded under (`approved_by` is an FK to auth.users), and the address a
 * sign-in link goes to. The oldest owner membership, which for a store the
 * app set up is the owner it created.
 */
export interface AccountOwner {
  userId: string;
  email: string | null;
  /** Created with an address that cannot receive mail (lib/shopify/provision.ts). */
  placeholder: boolean;
  user: Pick<User, "email" | "user_metadata">;
}

export async function accountOwner(db: SupabaseClient, accountId: string): Promise<AccountOwner | null> {
  const { data: member } = await db
    .from("account_members")
    .select("user_id")
    .eq("account_id", accountId)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!member?.user_id) return null;
  const { data } = await db.auth.admin.getUserById(member.user_id as string);
  const user = data?.user;
  if (!user) return null;
  return {
    userId: user.id,
    email: user.email ?? null,
    placeholder: Boolean(user.user_metadata?.placeholder) || (user.email ?? "").endsWith(".invalid"),
    user: { email: user.email, user_metadata: user.user_metadata },
  };
}
