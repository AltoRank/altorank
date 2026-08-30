import { createClient } from "@/lib/supabase/server";
import type { PublishingCadence, PublishLogEntry } from "@/lib/types";

export async function getPublishingCadence(
  workspaceId: string,
): Promise<PublishingCadence | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("publishing_cadences")
    .select("*")
    .eq("workspace_id", workspaceId)
    .single();

  if (error) return null;
  return data as PublishingCadence;
}

export async function getPublishLog(
  workspaceId: string,
  limit = 20,
): Promise<PublishLogEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("publish_log")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []) as PublishLogEntry[];
}
