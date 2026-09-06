import { createClient } from "@/lib/supabase/server";
import type { ApiKeyRow } from "@/lib/types";

/**
 * The account's API keys, newest first. Never selects `key_hash`: the list
 * has no use for it and a page that never receives it cannot leak it.
 */
export async function getApiKeys(): Promise<ApiKeyRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, agency_id, name, prefix, scopes, expires_at, last_used_at, revoked_at, created_by, created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ApiKeyRow[];
}
