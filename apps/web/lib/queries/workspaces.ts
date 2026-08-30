import { createClient } from "@/lib/supabase/server";
import type { Workspace } from "@/lib/types";

export async function getWorkspaces(status?: string): Promise<Workspace[]> {
  const supabase = await createClient();
  let query = supabase.from("workspaces").select("*").order("created_at", { ascending: true });

  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Workspace[];
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return null;
  return data as Workspace;
}
