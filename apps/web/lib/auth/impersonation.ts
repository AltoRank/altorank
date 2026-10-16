import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { decodeStash, IMPERSONATION_COOKIE } from "@/lib/auth/impersonation-stash";

export type ActiveImpersonation = {
  operatorEmail: string;
  targetId: string;
  targetEmail: string;
  startedAt: string;
};

/**
 * The impersonation this browser is inside, or null.
 *
 * Null covers three cases the layout should treat identically: no cookie, a
 * cookie that is not ours, and a cookie left over from a session this browser
 * no longer holds (the operator signed out, or the customer's session ended
 * underneath them). The check is against the verified claims of the current
 * session, never the cookie alone, so the banner is a statement about who is
 * really signed in rather than about what the browser remembers.
 */
export async function getImpersonation(): Promise<ActiveImpersonation | null> {
  const jar = await cookies();
  const stash = decodeStash(jar.get(IMPERSONATION_COOKIE)?.value);
  if (!stash) return null;

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims || claims.sub !== stash.target.id || claims.session_id !== stash.sessionId) return null;

  return {
    operatorEmail: stash.operator.email,
    targetId: stash.target.id,
    targetEmail: stash.target.email,
    startedAt: stash.startedAt,
  };
}

/**
 * The sentence a paid action answers with while an operator is viewing as
 * the account, or null when nobody is.
 *
 * "View as" is a real sign-in as the customer, so anything the operator
 * presses is bought on the customer's account and counted in their limits:
 * opening a stranded signup ran the setup wizard's site read and rival
 * lookup on mount, and its auto-start would have spent their one setup run.
 * Those doors refuse instead. Reading what is already there stays open.
 */
export async function refusedWhileViewingAs(what: string): Promise<string | null> {
  let active: ActiveImpersonation | null = null;
  try {
    active = await getImpersonation();
  } catch {
    // No request to read a cookie from (a worker, a test): nobody is viewing.
    return null;
  }
  return active
    ? `${what} is not run while viewing as ${active.targetEmail}: it would be bought on their account. Stop viewing as them, or ask them to do it.`
    : null;
}
