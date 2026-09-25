import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getScope } from "@/lib/workspace-scope";
import type { Account } from "@/lib/types";

/**
 * The account the signed-in person is working in: the one that owns the site
 * in scope (lib/workspace-scope.ts), or their oldest membership when they can
 * see no site. It used to read the membership with `.single()`, which
 * PostgREST refuses for a person in two accounts, so Settings said "No
 * account found" to anyone who had accepted a second invitation.
 */
export async function getAccount(): Promise<Account | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  let accountId = (await getScope())?.accountId ?? null;
  if (!accountId) {
    const { data: member } = await supabase
      .from("account_members")
      .select("account_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    accountId = (member?.account_id as string | undefined) ?? null;
  }
  if (!accountId) return null;

  const { data } = await supabase
    .from("accounts")
    .select("*")
    .eq("id", accountId)
    .single();

  return (data as Account) ?? null;
}

/**
 * The account a signed-in person is working in, created if they have none:
 * the account of the site in scope, else their oldest membership, else a new
 * account. What the dashboard layout gates on and what "Add site" adds to,
 * so the site a person adds lands in the account they are looking at.
 */
export async function workingAccountId(user: {
  id: string;
  user_metadata?: Record<string, unknown> | null;
  email?: string | null;
}): Promise<string> {
  return (await getScope())?.accountId ?? ensureAccount(user.id, user.user_metadata ?? {}, user.email);
}

/**
 * The free drafts this person has already used in accounts they created, for
 * an account made for them again.
 *
 * This path runs when somebody has no membership left, and a person can
 * arrive here after being removed from an account they made: a co-owner
 * deletes their membership, and their next page load lands here. The new
 * account started at zero, so a pre-trial article and the free drafts behind
 * it were handed out again - as often as two addresses took turns removing
 * each other (round-5 review; migration 102 keeps anyone but an owner from
 * removing an owner, which leaves this pair). The allowance belongs to the
 * person who created the account (`accounts.created_by`, migration 101), so
 * the count comes with them. Read with the service role; a failed read throws
 * rather than starting them at zero.
 */
async function draftsAlreadyUsed(admin: ReturnType<typeof createServiceClient>, userId: string): Promise<number> {
  const { data, error } = await admin.from("accounts").select("free_drafts_used").eq("created_by", userId);
  if (error) throw new Error(`Could not read the accounts this person created: ${error.message}`);
  return Math.max(0, ...(data ?? []).map((a) => (a.free_drafts_used as number | null) ?? 0));
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
    // The oldest, so the answer is the same on every call. Without an order
    // it was whichever row PostgREST returned first, and for a person in two
    // accounts that was not stable. Callers that know which site is being
    // worked on ask about that site's account instead (lib/workspace-scope.ts).
    .order("created_at", { ascending: true })
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
    .insert({ name, slug: `${slug}-${Date.now()}`, free_drafts_used: await draftsAlreadyUsed(admin, userId) })
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
