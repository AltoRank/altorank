import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/auth/operators";

/**
 * Whether an agency is one of ours.
 *
 * The operator bypass in getQuota is keyed on the signed-in address, and a
 * cron has no signed-in address - it passes null on purpose, because "a cron
 * is nobody's operator". That is right about sessions and wrong about
 * accounts: our own agency is still our own agency at three in the morning,
 * and with that check unavailable every cron treated it as a stranger.
 *
 * In production that meant the operator's own workspaces got FREE_DRAFTS = 1
 * from cron/generate and, once scheduled work was gated on a plan, no rank
 * tracking at all. The account that most needs to see the product working was
 * the one the product had quietly stopped running for.
 *
 * auth.users is not reachable through PostgREST, so membership is resolved
 * through the admin API - by id, for the handful of members an agency has,
 * rather than by listing every user in the system. Cached for the life of the
 * process, which for a cron is the length of one run.
 */

const cache = new Map<string, boolean>();

export async function agencyHasOperator(
  supabase: SupabaseClient,
  agencyId: string,
): Promise<boolean> {
  const hit = cache.get(agencyId);
  if (hit !== undefined) return hit;

  let answer = false;
  try {
    const { data: members } = await supabase
      .from("agency_members")
      .select("user_id")
      .eq("agency_id", agencyId);

    for (const m of members ?? []) {
      // Needs the service role. On a cookie-bound client this throws, which
      // the catch turns into "not an operator" - the safe direction: an
      // account is metered unless we can prove it is ours.
      const { data } = await supabase.auth.admin.getUserById(m.user_id as string);
      if (isAdminEmail(data?.user?.email)) {
        answer = true;
        break;
      }
    }
  } catch {
    answer = false;
  }

  cache.set(agencyId, answer);
  return answer;
}

/** Test seam: the cache outlives a single cron run only in tests. */
export function clearOperatorAgencyCache(): void {
  cache.clear();
}
