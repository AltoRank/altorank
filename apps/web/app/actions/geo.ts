"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { addPrompts, removePrompts, setTracking } from "@/lib/geo/setup";

// The /geo setup card's doors onto lib/geo/setup.ts, through the member's own
// client. The agent API calls the same core with the service role.

/** Refusals travel as data: Next.js hides a thrown action message in production. */
export type GeoActionResult = { ok: true } | { ok: false; error: string };

export async function setGeoTracking(workspaceId: string, enabled: boolean): Promise<GeoActionResult> {
  const { accountId, user } = await requireAuth();
  const res = await setTracking(await createClient(), accountId, workspaceId, enabled, user.email ?? null);
  if (res.ok) revalidatePath("/geo");
  return res;
}

export async function addGeoPrompt(workspaceId: string, raw: string): Promise<GeoActionResult> {
  const { accountId } = await requireAuth();
  const res = await addPrompts(await createClient(), accountId, workspaceId, [raw]);
  if (res.added.length) revalidatePath("/geo");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function removeGeoPrompt(workspaceId: string, promptId: string): Promise<GeoActionResult> {
  const { accountId } = await requireAuth();
  const res = await removePrompts(await createClient(), accountId, workspaceId, [promptId]);
  if (res.ok) revalidatePath("/geo");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
