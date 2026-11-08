// ---------------------------------------------------------------------------
// Switching AI visibility on, and the questions it asks, for one site
// ---------------------------------------------------------------------------
//
// One core for both doors: the /geo setup card (app/actions/geo.ts, the
// member's own client) and the agent API (/api/agent/v1/geo/*, the service
// role). Every write names the account as well as the workspace, because the
// agent's client has no RLS behind it and every id arrives from outside.

import type { SupabaseClient } from "@supabase/supabase-js";
import { entitledToScheduledWork, getQuota } from "@/lib/billing/quota";
import { GEO_PROMPT_LIMIT, normaliseGeoPrompt } from "./prompts";

export type GeoSetupResult = { ok: true } | { ok: false; error: string };

const NOT_IN_ACCOUNT = "That site isn't in your account.";

async function siteInAccount(db: SupabaseClient, accountId: string, workspaceId: string): Promise<boolean> {
  const { data } = await db.from("workspaces").select("id").eq("id", workspaceId).eq("account_id", accountId).maybeSingle();
  return Boolean(data);
}

export async function setTracking(
  db: SupabaseClient,
  accountId: string,
  workspaceId: string,
  enabled: boolean,
  email: string | null,
): Promise<GeoSetupResult> {
  if (enabled) {
    // cron/geo skips an account with no plan; saying so here beats a switch
    // that reads "on" and a page that never fills.
    const quota = await getQuota(db, accountId, email);
    if (!entitledToScheduledWork(quota)) {
      return { ok: false, error: "AI visibility tracking runs on a paid plan. Choose one on the Billing page." };
    }
  }
  const { data, error } = await db
    .from("workspaces")
    .update({ geo_tracking: enabled })
    .eq("id", workspaceId)
    .eq("account_id", accountId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: NOT_IN_ACCOUNT };
  return { ok: true };
}

/** Add questions in order; stops at the first refusal and says which. */
export async function addPrompts(
  db: SupabaseClient,
  accountId: string,
  workspaceId: string,
  raw: unknown[],
): Promise<GeoSetupResult & { added: string[] }> {
  const added: string[] = [];
  if (!(await siteInAccount(db, accountId, workspaceId))) return { ok: false, error: NOT_IN_ACCOUNT, added };

  const { count } = await db
    .from("geo_prompts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  let total = count ?? 0;

  for (const item of raw) {
    const prompt = normaliseGeoPrompt(item);
    if (!prompt.ok) return { ...prompt, added };
    if (total >= GEO_PROMPT_LIMIT) {
      return { ok: false, error: `Up to ${GEO_PROMPT_LIMIT} questions a site. Remove one first.`, added };
    }
    const { error } = await db.from("geo_prompts").insert({ workspace_id: workspaceId, prompt: prompt.value });
    if (error) {
      // geo_prompts is unique on (workspace_id, prompt).
      const message = error.code === "23505" ? `"${prompt.value}" is already on the list.` : error.message;
      return { ok: false, error: message, added };
    }
    added.push(prompt.value);
    total += 1;
  }
  return { ok: true, added };
}

/**
 * Remove questions, named by id or by their exact text. Past answers stay
 * (geo_results.prompt_id is set null, the text is kept), so earlier sweeps
 * still read; the next sweep stops asking them.
 */
export async function removePrompts(
  db: SupabaseClient,
  accountId: string,
  workspaceId: string,
  refs: string[],
): Promise<GeoSetupResult & { removed: string[] }> {
  if (!(await siteInAccount(db, accountId, workspaceId))) return { ok: false, error: NOT_IN_ACCOUNT, removed: [] };
  const { data: rows, error } = await db.from("geo_prompts").select("id, prompt").eq("workspace_id", workspaceId);
  if (error) return { ok: false, error: error.message, removed: [] };

  const wanted = new Set(refs.map((r) => r.trim().toLowerCase()));
  const hits = (rows ?? []).filter((r) => wanted.has(String(r.id)) || wanted.has(String(r.prompt).toLowerCase()));
  if (!hits.length) return { ok: true, removed: [] };

  const { error: deleteError } = await db
    .from("geo_prompts")
    .delete()
    .eq("workspace_id", workspaceId)
    .in("id", hits.map((r) => r.id));
  if (deleteError) return { ok: false, error: deleteError.message, removed: [] };
  return { ok: true, removed: hits.map((r) => String(r.prompt)) };
}
