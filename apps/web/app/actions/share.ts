"use server";

// ---------------------------------------------------------------------------
// The share link: created on first share, revoked on request
// ---------------------------------------------------------------------------
//
// Both actions run on the caller's cookie client and name the workspace, so
// RLS answers "is this yours" and the explicit id answers "which site". The
// token itself is generated here and never returned for a foreign id.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { generateShareToken } from "@/lib/share/token";

async function readToken(workspaceId: string): Promise<{ supabase: Awaited<ReturnType<typeof createClient>>; token: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("workspaces").select("id, share_token").eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("That site is not on this account.");
  return { supabase, token: (data.share_token as string | null) ?? null };
}

/** The workspace's share token, minting one the first time. */
export async function createShareLink(workspaceId: string): Promise<{ token: string }> {
  const { supabase, token } = await readToken(workspaceId);
  if (token) return { token };
  const fresh = generateShareToken();
  // `.is(null)` makes two concurrent first shares agree on one token: the
  // second update matches nothing and the re-read below returns the winner.
  const { error } = await supabase.from("workspaces").update({ share_token: fresh }).eq("id", workspaceId).is("share_token", null);
  if (error) throw new Error(error.message);
  const after = await readToken(workspaceId);
  if (!after.token) throw new Error("Could not create the share link.");
  revalidatePath("/dashboard");
  return { token: after.token };
}

/** Kill every copy of the link. A new "Copy link" mints a different token. */
export async function revokeShareLink(workspaceId: string): Promise<void> {
  const { supabase } = await readToken(workspaceId);
  const { error } = await supabase.from("workspaces").update({ share_token: null }).eq("id", workspaceId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}
