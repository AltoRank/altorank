import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getQuota, type Quota } from "@/lib/billing/quota";

/**
 * The signed-in account's quota, computed once per request.
 *
 * The dashboard layout needs it for the sidebar's usage bar and the planner
 * needs it for the "Write now" gate, and both render in the same pass. Each
 * computed it independently: three sequential reads (workspaces, this month's
 * article count, the agency's plan) at the tail of two separate await chains.
 *
 * `cache` keys on the arguments, which is why this takes the agency id and the
 * caller's email as plain values and builds its own client, the same way
 * `getWorkspaces` does: a Supabase client passed in would be a fresh object
 * per call and never match. Pass `null` for the email only when there is no
 * session at all - that is the crons' signal to `getQuota`, and a different
 * fact from a session with no address.
 */
export const getRequestQuota = cache(async function getRequestQuota(
  agencyId: string,
  userEmail: string | null,
): Promise<Quota> {
  const supabase = await createClient();
  return getQuota(supabase, agencyId, userEmail);
});
