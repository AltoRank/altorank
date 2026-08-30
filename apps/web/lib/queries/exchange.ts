import { createClient } from "@/lib/supabase/server";
import type { BacklinkExchange, BacklinkCredit } from "@/lib/types";

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
 * Get available exchange requests (not from this agency).
 */
export async function getAvailableExchanges(agencyId: string): Promise<BacklinkExchange[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("backlink_exchanges")
    .select("*")
    .eq("status", "requested")
    .neq("requester_agency_id", agencyId)
    .is("provider_agency_id", null)
    .order("credits_offered", { ascending: false });

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
