import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { BacklinkExchange, BacklinkCredit } from "@/lib/types";

/** What a host is shown about somebody else's open request. */
export type OpenRequest = {
  id: string;
  /** The page the citation would point at. The host has to see what they are
   *  linking to; that is the editorial decision. */
  targetUrl: string;
  targetKeyword: string | null;
  targetTopic: string | null;
  creditsOffered: number;
  createdAt: string;
  expiresAt: string | null;
};

/**
 * Open requests from other accounts.
 *
 * Deliberately the service role with a hand-written column list, rather than a
 * wider RLS policy. `getAvailableExchanges` below cannot work and never could:
 * migration 011 lets a member see a row only where their agency is the
 * requester or the provider, and an unclaimed request is neither, so it has
 * always returned an empty set. That is why the exchange had no host side.
 *
 * A marketplace has to expose the request, so the fix is to expose exactly the
 * request: the URL, the topic, the keyword, the price. Not the requester's
 * agency or workspace ids, which are nobody else's business, and which a
 * policy that widened the row would have handed over with it.
 */
export async function getOpenRequests(agencyId: string): Promise<OpenRequest[]> {
  const admin = createServiceClient();
  const { data, error } = await admin
    .from("backlink_exchanges")
    .select("id, target_url, target_keyword, target_topic, credits_offered, created_at, expires_at")
    .eq("status", "requested")
    .is("provider_agency_id", null)
    // No self-dealing: filtered on, never selected.
    .neq("requester_agency_id", agencyId)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("credits_offered", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    targetUrl: r.target_url as string,
    targetKeyword: (r.target_keyword as string | null) ?? null,
    targetTopic: (r.target_topic as string | null) ?? null,
    creditsOffered: (r.credits_offered as number) ?? 0,
    createdAt: r.created_at as string,
    expiresAt: (r.expires_at as string | null) ?? null,
  }));
}

/**
 * Get all exchanges for an agency (as requester or provider).
 */
export async function getExchanges(agencyId: string): Promise<BacklinkExchange[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("backlink_exchanges")
    .select("*")
    .or(`requester_agency_id.eq.${agencyId},provider_agency_id.eq.${agencyId}`)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as BacklinkExchange[];
}

/**
 * Get the credit ledger for an agency.
 */
export async function getCreditsLedger(agencyId: string): Promise<BacklinkCredit[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("backlink_credits")
    .select("*")
    .eq("agency_id", agencyId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as BacklinkCredit[];
}
