import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Workspace } from "@/lib/types";

/**
 * Deduplicated for the length of one request.
 *
 * The dashboard layout asks for the workspace list, and so do eight of the
 * pages that render inside it. Layout and page run in the same pass, so
 * without this every one of those routes ran the same query twice.
 *
 * `cache` keys on the arguments, which is why these getters take plain values
 * and build their own client instead of being handed one: a Supabase client
 * passed in would be a fresh object per call and would never match.
 */
export const getWorkspaces = cache(async function getWorkspaces(
  status?: string,
): Promise<Workspace[]> {
  const supabase = await createClient();
  let query = supabase.from("workspaces").select("*").order("created_at", { ascending: true });

  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Workspace[];
});

/** Deduplicated per request: `generateMetadata` and the page both ask. */
export const getWorkspace = cache(async function getWorkspace(
  id: string,
): Promise<Workspace | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return null;
  return data as Workspace;
});
