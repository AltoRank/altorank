// ---------------------------------------------------------------------------
// Accounts for a test to own, and a way in that never involves a password
// ---------------------------------------------------------------------------
//
// Mirrors scripts/dogfood.ts and the signup action: a user, an agency, a
// membership and one workspace per site, with the same columns those write.
// Nothing that looks like a measurement is seeded - `dr` and `traffic` stay
// null - because the suite asserts what the product shows, and a fixture that
// invents a number is the failure this codebase keeps having to undo.
//
// The user is created without a password and signed in through a magic link
// minted by the admin API, verified by the app's own /callback route. No
// credential is typed, stored or logged anywhere in the suite.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { FREE_TIER_PACE } from "@/lib/content/pace";
import { SUPABASE_URL, SERVICE_ROLE_KEY } from "./env";

export interface WorkspaceSpec {
  domain: string;
  /**
   * True marks the wizard as finished (a saved profile and `onboarded_at`), so
   * the dashboard does not redirect to /onboarding. Default false: a fresh
   * workspace, which is what the onboarding specs need.
   */
  onboarded?: boolean;
}

export interface Account {
  email: string;
  userId: string;
  agencyId: string;
  agencyName: string;
  workspaces: { id: string; domain: string }[];
}

let seq = 0;

/** Unique per call within and across runs; short enough to read in a table. */
export function uniqueTag(): string {
  return `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Service-role client. Bypasses RLS; only ever pointed at localhost (env.ts). */
export function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Delete an agency, cascading every workspace row, retrying a transient
 * statement timeout. The single source of truth for "remove this account's
 * data": both the abandon path in createAccount and destroyAccount use it, so
 * neither leaves an orphan agency when a cascade delete times out under load.
 */
async function deleteAgency(db: SupabaseClient, agencyId: string): Promise<void> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await db.from("agencies").delete().eq("id", agencyId);
    if (!error) return;
    lastError = error.message;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`delete agency: ${lastError}`);
}

export async function createAccount(opts: { workspaces?: WorkspaceSpec[] } = {}): Promise<Account> {
  const db = admin();
  const tag = uniqueTag();
  const email = `e2e+${tag}@altorank.test`;
  const agencyName = `E2E ${tag}`;

  // GoTrue's admin API times out transiently under a cold server's load; it is
  // a queue, not a rejection, and a half-created user with no test to tear it
  // down is exactly the leak this retry prevents. Bounded and short.
  let userId = "";
  for (let attempt = 0; ; attempt++) {
    const { data: created, error: userError } = await db.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { name: agencyName },
    });
    if (created?.user) {
      userId = created.user.id;
      break;
    }
    if (attempt >= 3) throw new Error(`createUser: ${userError?.message}`);
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    // Adopt a user the timed-out call may actually have created.
    const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 });
    const existing = list?.users.find((u) => u.email === email);
    if (existing) {
      userId = existing.id;
      break;
    }
  }

  // From here on, a failure removes what was already created: a half-built
  // account has no test to tear it down.
  let agencyId: string | null = null;
  const abandon = async (why: string): Promise<never> => {
    // Clean up what was created before re-raising the real cause; a failure to
    // clean up must not mask why the account could not be built.
    if (agencyId) await deleteAgency(db, agencyId).catch(() => {});
    await db.auth.admin.deleteUser(userId).catch(() => {});
    throw new Error(why);
  };

  const { data: agency, error: agencyError } = await db
    .from("agencies")
    .insert({ name: agencyName, slug: `e2e-${tag}` })
    .select("id")
    .single();
  if (agencyError || !agency) return abandon(`agency: ${agencyError?.message}`);
  agencyId = agency.id as string;

  const { error: memberError } = await db
    .from("agency_members")
    .insert({ agency_id: agencyId, user_id: userId, role: "owner" });
  if (memberError) return abandon(`membership: ${memberError.message}`);

  const specs = opts.workspaces ?? [{ domain: `${tag}.altorank.test` }];
  const workspaces: Account["workspaces"] = [];
  // Sequential on purpose: the scope fallback is "oldest workspace", and the
  // specs rely on the first listed being the first created.
  for (const spec of specs) {
    const now = new Date().toISOString();
    const { data: ws, error: wsError } = await db
      .from("workspaces")
      .insert({
        agency_id: agencyId,
        name: spec.domain,
        domain: spec.domain,
        initials: spec.domain.slice(0, 2).toUpperCase(),
        color: "av-c1",
        // Same opt-in and pace as the signup action.
        auto_generate: true,
        auto_generate_weekly_limit: FREE_TIER_PACE,
        ...(spec.onboarded
          ? {
              business_profile: {
                name: spec.domain,
                language: "English",
                country: "Global (English)",
                description: "Set up by the e2e fixture.",
                audiences: [],
                competitors: [],
              },
              onboarded_at: now,
            }
          : {}),
        // dr and traffic deliberately absent: nothing has been measured.
      })
      .select("id, domain")
      .single();
    if (wsError || !ws) return abandon(`workspace ${spec.domain}: ${wsError?.message}`);
    workspaces.push({ id: ws.id as string, domain: ws.domain as string });
  }

  return { email, userId, agencyId, agencyName, workspaces };
}

/**
 * The agency first (cascades every workspace row), then the user.
 *
 * Retried: the cascade delete can hit a statement timeout under load, and a
 * teardown that gives up leaves rows behind for the next run to trip over.
 */
export async function destroyAccount(account: Account): Promise<void> {
  const db = admin();
  await deleteAgency(db, account.agencyId);
  // GoTrue's admin API answers "Processing this request timed out" under the
  // same load that makes the cascade delete slow; like createUser above, it is
  // a queue, not a refusal. Bounded and short, so a real failure still shows.
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error: userError } = await db.auth.admin.deleteUser(account.userId);
    // "User not found" on a retry means the attempt that timed out went through.
    if (!userError || /not found/i.test(userError.message)) return;
    lastError = userError.message;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`teardown user: ${lastError}`);
}

/**
 * Sign the browser in as `email` by visiting the app's own callback with a
 * freshly minted magic-link token. Ends on `next` (or wherever the app sends a
 * signed-in user from there).
 */
export async function signIn(page: Page, email: string, next = "/dashboard"): Promise<void> {
  const db = admin();
  const { data, error } = await db.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) throw new Error(`generateLink: ${error?.message ?? "no hashed_token returned"}`);
  await page.goto(
    `/callback?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&next=${encodeURIComponent(next)}`,
  );
}

/** Today as the plan writes it: YYYY-MM-DD in UTC. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
