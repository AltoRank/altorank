import { createClient } from "@/lib/supabase/server";
import { latestGeoRun, type GeoResultRow, type GeoRun } from "@/lib/geo/read";

export { summariseRows, type GeoResultRow, type GeoRun } from "@/lib/geo/read";

export interface GeoPrompt {
  id: string;
  workspace_id: string;
  prompt: string;
  enabled: boolean;
  created_at: string;
}

export async function getGeoPrompts(workspaceId?: string): Promise<GeoPrompt[]> {
  const supabase = await createClient();
  let query = supabase.from("geo_prompts").select("*").order("created_at");
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  const { data } = await query;
  return (data ?? []) as GeoPrompt[];
}

/** The newest finished sweep of one site (lib/geo/read.ts), through the member's own client. */
export async function getLatestGeoRun(workspaceId: string): Promise<{ run: GeoRun; rows: GeoResultRow[] } | null> {
  return latestGeoRun(await createClient(), workspaceId);
}
