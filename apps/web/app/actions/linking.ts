"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { detectLinks, type DetectResult, type SourceKind } from "@/lib/linking/detect";

// Every action names its workspace and RLS confines it to the caller's
// agency, so a foreign id misses rather than widens. `requireAuth` is for the
// session itself: an anonymous call must fail before it reaches the database.

const KINDS: SourceKind[] = ["sitemap", "blog_root", "manual_url"];

function cleanUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  u.hash = "";
  return u.toString();
}

export async function addLinkSource(
  workspaceId: string,
  kind: SourceKind,
  url: string,
): Promise<{ error?: string }> {
  await requireAuth();
  if (!KINDS.includes(kind)) return { error: "Unknown source kind." };
  let clean: string;
  try {
    clean = cleanUrl(url);
  } catch {
    return { error: "That is not a URL." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("link_sources")
    .upsert(
      { workspace_id: workspaceId, kind, url: clean },
      { onConflict: "workspace_id,url", ignoreDuplicates: true },
    );
  if (error) return { error: error.message };
  revalidatePath("/linking");
  return {};
}

export async function removeLinkSource(workspaceId: string, sourceId: string): Promise<void> {
  await requireAuth();
  const supabase = await createClient();
  const { error } = await supabase
    .from("link_sources")
    .delete()
    .eq("id", sourceId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  revalidatePath("/linking");
}

export async function setLinkSourceEnabled(
  workspaceId: string,
  sourceId: string,
  enabled: boolean,
): Promise<void> {
  await requireAuth();
  const supabase = await createClient();
  const { error } = await supabase
    .from("link_sources")
    .update({ enabled })
    .eq("id", sourceId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  revalidatePath("/linking");
}

/** The "Detect links" button. Reads every enabled source and fills the pool. */
export async function runLinkDetection(workspaceId: string): Promise<DetectResult> {
  await requireAuth();
  const supabase = await createClient();
  const result = await detectLinks(supabase, workspaceId);
  revalidatePath("/linking");
  return result;
}

export async function updateLinkTarget(
  workspaceId: string,
  targetId: string,
  patch: { priority?: number; enabled?: boolean; anchors?: string[] },
): Promise<void> {
  await requireAuth();
  const updates: Record<string, unknown> = {};
  if (typeof patch.priority === "number") {
    updates.priority = Math.max(0, Math.min(3, Math.round(patch.priority)));
  }
  if (typeof patch.enabled === "boolean") updates.enabled = patch.enabled;
  if (Array.isArray(patch.anchors)) {
    updates.anchors = [...new Set(patch.anchors.map((a) => a.trim()).filter(Boolean))].slice(0, 10);
  }
  if (Object.keys(updates).length === 0) return;

  const supabase = await createClient();
  const { error } = await supabase
    .from("link_targets")
    .update(updates)
    .eq("id", targetId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  revalidatePath("/linking");
}
