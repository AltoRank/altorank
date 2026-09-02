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
