import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/auth/operators";

/**
 * Whether an account is one of ours.
 *
 * The operator bypass in getQuota is keyed on the signed-in address, and a
 * cron has no signed-in address - it passes null on purpose, because "a cron
 * is nobody's operator". That is right about sessions and wrong about
 * accounts: our own account is still our own account at three in the morning,
 * and with that check unavailable every cron treated it as a stranger.
 *
 * In production that meant the operator's own workspaces got only the free
 * tier's allowance from cron/generate - FREE_DRAFTS, which was 1 at the time
 * and is 7 now - and, once scheduled work was gated on a plan, no rank
 * tracking at all. The account that most needs to see the product working was
 * the one the product had quietly stopped running for.
 *
 * "Ours" means an operator CREATED it: `accounts.created_by`, which the
 * database sets from the account's first membership and no client can write
 * (migration 101). It used to mean "any member is an operator", and
 * membership is the account owner's to give: an owner could insert an
 * operator's user id into their own account over PostgREST, and an operator
 * who accepted an invitation to help a customer made that customer's account
 * ours too - its crons unmetered, its drafting not held for the trial, its
 * publisher no longer locking the text (round-4 review). Being invited is not
 * being the account.
 *
 * auth.users is not reachable through PostgREST, so the creator's address is
 * resolved through the admin API, which needs the service role. Cached for
 * the life of the process, which for a cron is the length of one run - but
 * only an answer from a lookup that completed.
 */

const cache = new Map<string, boolean>();

export async function accountHasOperator(
  supabase: SupabaseClient,
  accountId: string,
): Promise<boolean> {
  const hit = cache.get(accountId);
  if (hit !== undefined) return hit;

  // Only a lookup that completed is remembered. A client that cannot read
  // auth.users (a cookie-bound one) gets "not an operator" for this call - the
  // safe direction, metered unless proven ours - but that is a fact about the
  // client, not the account, and caching it made every later caller in the
  // process, the service-role crons included, meter our own account.
  let answer = false;
  let settled = false;
  try {
    const { data: account, error } = await supabase
      .from("accounts")
      .select("created_by")
      .eq("id", accountId)
      .maybeSingle();
    if (error) {
      // Before migration 101 the column does not exist, and every account
      // reads as a customer's until it is applied: said, not guessed.
      console.error(`[operator-account] could not read the creator of account ${accountId}: ${error.message}`);
    } else if (!account?.created_by) {
      // No creator on record (their user was deleted, or the account has no
      // member yet): not provably ours.
      settled = true;
    } else {
      const { data, error: userError } = await supabase.auth.admin.getUserById(account.created_by as string);
      if (!userError) {
        answer = isAdminEmail(data?.user?.email);
        settled = true;
      }
    }
  } catch {
    answer = false;
    settled = false;
  }

  if (settled) cache.set(accountId, answer);
  return answer;
}

/** Test seam: the cache outlives a single cron run only in tests. */
export function clearOperatorAccountCache(): void {
  cache.clear();
}
