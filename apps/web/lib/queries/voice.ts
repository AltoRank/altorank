import { createClient } from "@/lib/supabase/server";
import type { VoiceProfile } from "@/lib/types";

export async function getVoiceProfile(workspaceId: string): Promise<VoiceProfile | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("voice_profiles")
    .select("*")
    .eq("workspace_id", workspaceId)
    .single();

  if (error) return null;
  return data as VoiceProfile;
}

export async function getVoiceProfiles(): Promise<VoiceProfile[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("voice_profiles")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as VoiceProfile[];
}
