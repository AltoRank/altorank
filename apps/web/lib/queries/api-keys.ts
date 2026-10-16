import { createClient } from "@/lib/supabase/server";
import type { ApiKeyRow } from "@/lib/types";
import { isMissingColumn } from "@/lib/supabase/missing-column";

const COLUMNS = "id, account_id, name, prefix, scopes, expires_at, last_used_at, revoked_at, created_by, created_at";

/**
 * The account's API keys, newest first. Never selects `key_hash`: the list
 * has no use for it and a page that never receives it cannot leak it.
 */
export async function getApiKeys(): Promise<ApiKeyRow[]> {
  const supabase = await createClient();
  const read = (cols: string) => supabase.from("api_keys").select(cols).order("created_at", { ascending: false });
  // A blog key's site comes from migration 114; before it, every key is an
  // agent key and the list reads the same without the column.
  let { data, error } = await read(`${COLUMNS}, workspace_id`);
  if (isMissingColumn(error)) ({ data, error } = await read(COLUMNS));
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ApiKeyRow[];
}
