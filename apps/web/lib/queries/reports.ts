import { createClient } from "@/lib/supabase/server";
import type { Report } from "@/lib/types";

export async function getReports(workspaceId?: string): Promise<Report[]> {
  const supabase = await createClient();
  let query = supabase
    .from("reports")
    .select("*")
    .order("created_at", { ascending: false });

  if (workspaceId) {
    query = query.eq("workspace_id", workspaceId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Report[];
}
