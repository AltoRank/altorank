import { createClient } from "@/lib/supabase/server";
import type { Integration, WorkspaceIntegration } from "@/lib/types";

export async function getIntegrations(): Promise<Integration[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("integrations")
    .select("*")
    .order("name");

  if (error) throw new Error(error.message);
  return (data ?? []) as Integration[];
}

export async function getWorkspaceIntegrations(workspaceId: string): Promise<(WorkspaceIntegration & { integration: Integration })[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_integrations")
    .select("*, integration:integrations(*)")
    .eq("workspace_id", workspaceId);

  if (error) throw new Error(error.message);
  return (data ?? []) as (WorkspaceIntegration & { integration: Integration })[];
}
