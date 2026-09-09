import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { Account } from "@/lib/types";

export async function getAccount(): Promise<Account | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: member } = await supabase
    .from("account_members")
    .select("account_id")
    .eq("user_id", user.id)
    .single();

  if (!member) return null;

  const { data } = await supabase
    .from("accounts")
    .select("*")
    .eq("id", member.account_id)
    .single();

  return (data as Account) ?? null;
}

/**
 * Ensures the user has an account. Returns their account_id.
 * Fast path: single SELECT (user already has one).
 * Slow path: creates account + membership via service role (runs once).
 */
export async function ensureAccount(
  userId: string,
  meta: Record<string, unknown>,
  /**
   * Used only to name a row this call creates, when the metadata carries no
   * name. Optional so a caller that does not have it still works; both current
   * callers do.
   */
  email?: string | null,
): Promise<string> {
  const supabase = await createClient();

  const { data: existing, error } = await supabase
    .from("account_members")
    .select("account_id")
    .eq("user_id", userId)
    .limit(1)
    .single();

  if (existing) return existing.account_id;

  // Distinguish "this user has no account" from "the lookup failed". Only the
  // first justifies creating one.
  //
  // The error was previously discarded, so any failure fell through to the
  // create path. When an RLS recursion made this select raise on every call
  // (fixed in migration 016), the slug's Date.now() suffix meant nothing ever
  // collided and a fresh account plus membership was inserted on every page
  // load. Silently provisioning on an unknown error is the more dangerous half
  // of that bug, because it turns any transient database problem into runaway
  // writes rather than a visible failure.
  //
  // PGRST116 is PostgREST for "no rows", which is the genuine no-account case.
  if (error && error.code !== "PGRST116") {
    throw new Error(`Could not look up account membership: ${error.message}`);
  }

  // Auto-create using service role (bypasses RLS)
  const admin = createServiceClient();

  /**
   * What to call the row.
   *
   * Two things were wrong with `meta.name || "My Account"`. It read only
   * `name`, but an OAuth sign-in supplies `full_name` - and OAuth is exactly
   * the path that reaches here, since the signup form names the account
   * itself. So the one case this fallback exists for was also the one case it
   * had a name for and ignored. Everywhere else in the app already reads both
   * (app/actions/team.ts, admin/users).
   *
   * And "My Account" is not what this product sells any more. The table keeps
   * the name - it is the tenant row, and renaming it is a migration, not a
   * copy change - but a solo user on the free tier should not be greeted by a
   * word that now denotes the EUR199 tier. "Account" is the fallback the
   * sidebar already uses.
   */
  const fromMeta = (meta.name as string) || (meta.full_name as string) || "";
  const fromEmail = email?.split("@")[0]?.trim() ?? "";
  const name = fromMeta.trim() || fromEmail || "My account";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const { data: account } = await admin
    .from("accounts")
    .insert({ name, slug: `${slug}-${Date.now()}` })
    .select("id")
    .single();

  if (!account) throw new Error("Failed to create account");

  await admin.from("account_members").insert({
    account_id: account.id,
    user_id: userId,
    role: "owner",
  });

  return account.id;
}
