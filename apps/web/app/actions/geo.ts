"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { entitledToScheduledWork, getQuota } from "@/lib/billing/quota";
import { normaliseGeoPrompt, GEO_PROMPT_LIMIT } from "@/lib/geo/prompts";

// The two halves of switching AI visibility on, which until 2026-11-08 had no
// writer anywhere in the app: `workspaces.geo_tracking` and the prompt set.
// cron/geo reads both. Each write is scoped to the caller's account on top of
// RLS, because every id here arrives from the browser.

/** Refusals travel as data: Next.js hides a thrown action message in production. */
export type GeoActionResult = { ok: true } | { ok: false; error: string };

export async function setGeoTracking(workspaceId: string, enabled: boolean): Promise<GeoActionResult> {
  const { accountId, user } = await requireAuth();
  const supabase = await createClient();

  if (enabled) {
    // cron/geo skips an account with no plan; saying so here beats a switch
    // that reads "on" and a page that never fills.
    const quota = await getQuota(supabase, accountId, user.email ?? null);
    if (!entitledToScheduledWork(quota)) {
      return { ok: false, error: "AI visibility tracking runs on a paid plan. Choose one on the Billing page." };
    }
  }

  const { data, error } = await supabase
    .from("workspaces")
    .update({ geo_tracking: enabled })
    .eq("id", workspaceId)
    .eq("account_id", accountId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "That site isn't in your account." };

  revalidatePath("/geo");
  return { ok: true };
}

export async function addGeoPrompt(workspaceId: string, raw: string): Promise<GeoActionResult> {
  const { accountId } = await requireAuth();
  const prompt = normaliseGeoPrompt(raw);
  if (!prompt.ok) return prompt;

  const supabase = await createClient();
  const { data: ws } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!ws) return { ok: false, error: "That site isn't in your account." };

  const { count } = await supabase
    .from("geo_prompts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  if ((count ?? 0) >= GEO_PROMPT_LIMIT) {
    return { ok: false, error: `Up to ${GEO_PROMPT_LIMIT} questions a site. Remove one first.` };
  }

  const { error } = await supabase.from("geo_prompts").insert({ workspace_id: workspaceId, prompt: prompt.value });
  if (error) {
    // geo_prompts is unique on (workspace_id, prompt).
    return { ok: false, error: error.code === "23505" ? "That question is already on the list." : error.message };
  }

  revalidatePath("/geo");
  return { ok: true };
}

/**
 * Remove a question. Its past answers stay (geo_results.prompt_id is set null,
 * the text is kept), so earlier sweeps still read; the next sweep simply
 * stops asking it.
 */
export async function removeGeoPrompt(workspaceId: string, promptId: string): Promise<GeoActionResult> {
  const { accountId } = await requireAuth();
  const supabase = await createClient();

  const { data: ws } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!ws) return { ok: false, error: "That site isn't in your account." };

  const { error } = await supabase.from("geo_prompts").delete().eq("id", promptId).eq("workspace_id", workspaceId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/geo");
  return { ok: true };
}
