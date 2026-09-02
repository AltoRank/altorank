import { cookies } from "next/headers";
import { isAdminEmail } from "@/lib/auth/operators";
import { createClient } from "@/lib/supabase/server";
import {
  PREVIEW_COOKIE,
  parsePreview,
  hasPreviewCookie,
  type OperatorPreview,
} from "@/lib/auth/preview-cookie";

export { PREVIEW_COOKIE, hasPreviewCookie };
export type { OperatorPreview };

/**
 * "Show me what a customer sees" - in production, on the operator's own
 * account, without writing anything.
 *
 * There were two ways to answer that question and neither worked here. The dev
 * simulator (lib/dev/simulation.ts) is gated on NODE_ENV, so it is inert on
 * app.altorank.co, which is the only place the real plan gates, real quota and
 * real data live. Impersonation ("view as") does work in production, but it
 * signs you in as somebody else's account with full write access - the wrong
 * tool for checking your own screens, and far too sharp for the question.
 *
 * So: a preview of your own account with the operator bypasses switched off
 * and every write refused.
 *
 * ## Why this cookie needs no signature
 *
 * It only ever REMOVES privilege. Setting it costs you the operator nav, the
 * unmetered quota bypass, and the ability to write anything at all. A forged
 * cookie therefore buys an attacker a read-only view of the account they were
 * already signed into, which is not an escalation and not worth a signature.
 *
 * That direction is the whole safety argument, and it is why the dev
 * simulator's own header says simulating "admin: on" is only pretending while
 * "admin: off" is trustworthy. Anything here that ever GRANTS something must
 * be re-checked server-side against the real address instead.
 *
 * Enforcement of the read-only half does NOT live in this file: it lives in
 * middleware.ts, because `requireAuth` is not a chokepoint - 18 of the 29
 * server-action modules never call it and reach Supabase directly. A read-only
 * mode that guards the 11 and quietly lets the other 18 through would be worse
 * than none, because it would be believed.
 */

/**
 * The preview this browser is inside, or null.
 *
 * Returns null for a non-operator even when the cookie is set: the banner and
 * the customer-shaped nav are statements about an operator choosing to look
 * away from their own privileges, and they would be meaningless on an account
 * that never had any. Writes stay blocked either way - middleware does not
 * consult this function, deliberately, so that blocking cannot depend on a
 * lookup that might fail open.
 */
export async function getOperatorPreview(): Promise<OperatorPreview | null> {
  const jar = await cookies();
  const preview = parsePreview(jar.get(PREVIEW_COOKIE)?.value);
  if (!preview) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdminEmail(user?.email)) return null;

  return preview;
}


/**
 * Whether this request is inside a customer preview.
 *
 * Separate from `getOperatorPreview` because the callers differ: that one
 * needs the plan and runs where an operator check is already cheap, while this
 * is asked from `getQuota`, which also runs on the cron's service client where
 * there are no cookies at all. Returns false there rather than throwing.
 */
export async function inCustomerPreview(): Promise<boolean> {
  try {
    const jar = await cookies();
    return hasPreviewCookie(jar.get(PREVIEW_COOKIE)?.value);
  } catch {
    // `cookies()` throws outside a request scope - the cron, a build-time
    // render. Nobody is previewing there.
    return false;
  }
}
