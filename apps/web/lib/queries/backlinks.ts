import { createClient } from "@/lib/supabase/server";
import type { Backlink } from "@/lib/types";

export async function getBacklinks(
  workspaceId?: string,
  status?: string,
): Promise<Backlink[]> {
  const supabase = await createClient();
  let query = supabase.from("backlinks").select("*").order("discovered_at", { ascending: false });

  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Backlink[];
}
