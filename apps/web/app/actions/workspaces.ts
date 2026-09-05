"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ensureAgency } from "@/lib/queries/agency";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { generateIndexNowKey } from "@/lib/seo/indexing";
import { getWorkspaceAllowance, workspaceLimitMessage } from "@/lib/billing/workspaces";
import { MAX_PACE, normalisePace, PAID_DEFAULT_PACE } from "@/lib/content/pace";
import { pauseWorkspace as pauseWorkspaceCore, resumeWorkspace as resumeWorkspaceCore } from "@/lib/workspaces/pause";
import type { PausedMeta } from "@/lib/types";

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
  // Required since 2026-09-02: a workspace is a site, and one without a
  // domain cannot be analysed, seeded or drafted for. Normalised so
  // "https://www.Acme.com/" and "acme.com" are the same workspace.
  domain: z
    .string()
    .transform((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, ""))
    .pipe(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/, "Enter a domain like acme.com")),
  initials: z.string().max(2).default(""),
  color: z.string().default("av-c1"),
});

export async function createWorkspace(formData: FormData) {
  const supabase = await createClient();
  // `domain` comes via ?? undefined: FormData.get returns null for a missing
  // field, z.optional() only accepts undefined, and the difference took the
  // whole form down when the plan select was removed.
  const parsed = createWorkspaceSchema.parse({
    name: formData.get("name"),
    domain: formData.get("domain") ?? undefined,
    initials: formData.get("initials") || (formData.get("name") as string).slice(0, 2).toUpperCase(),
    color: formData.get("color") || "av-c1",
  });

  // Get or create user's agency
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const agencyId = await ensureAgency(user.id, user.user_metadata ?? {}, user.email);

  // Workspaces are limited per plan (one before choosing one). Articles are
  // the meter; this stops a free account from running fifty crawls and
  // fifty free drafts under fifty domains.
  const allowance = await getWorkspaceAllowance(supabase, agencyId, user.email);
  if (allowance.remaining !== null && allowance.remaining <= 0) {
    throw new Error(workspaceLimitMessage(allowance));
  }

  const { data: dup } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("agency_id", agencyId)
    .ilike("domain", parsed.domain)
    .maybeSingle();
  if (dup) throw new Error(`${parsed.domain} is already the workspace "${dup.name}". One workspace per site.`);

  const { data, error } = await supabase
    .from("workspaces")
    .insert({ ...parsed, agency_id: agencyId, indexnow_key: generateIndexNowKey() })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  revalidatePath("/workspaces");
  return data.id as string;
}

export async function updateWorkspace(id: string, formData: FormData) {
  await requireAuth();
  const supabase = await createClient();
  const updates: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (value) updates[key] = value;
  }

  const { error } = await supabase
    .from("workspaces")
    .update(updates)
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/workspaces");
  revalidatePath("/articles");
}

/**
 * How many articles a week the unattended generator may write for one site.
 *
 * The pricing page sells "at the pace you set per site" and until this action
 * there was no way to set it: the value was only ever written by signup, by
 * the Google property import and by activating a workspace, all to a fixed
 * number. `MAX_PACE` is what migration 041 allows, and 0 pauses the site
 * without turning `auto_generate` off, which keeps the distinction between
 * "not now" and "never" visible in the row.
 */
export async function setGenerationPace(workspaceId: string, requested: unknown) {
  const { agencyId } = await requireAuth();
  const pace = normalisePace(requested);
  if (pace === null) {
    throw new Error(`Pick a number of articles a week between 0 and ${MAX_PACE}.`);
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("workspaces")
    .update({ auto_generate_weekly_limit: pace })
    .eq("id", workspaceId)
    // Defence in depth over RLS, and the reason this is not a bare update:
    // the id arrives from the browser.
    .eq("agency_id", agencyId);
  if (error) throw new Error(error.message);

  revalidatePath(`/workspaces/${workspaceId}`);
  revalidatePath("/dashboard");
  return pace;
}

export async function activateWorkspace(id: string) {
  await requireAuth();
  const supabase = await createClient();
  // Activation is the opt-in. It used to set status only, so a workspace
  // activated by hand never got a draft: auto_generate stayed false and the
  // cron skipped it for ever, while the overview showed four zeros and
  // nothing else (2026-09-02). Two drafts a week is the default cadence.
  const { error } = await supabase
    .from("workspaces")
    .update({ status: "on", auto_generate: true, auto_generate_weekly_limit: PAID_DEFAULT_PACE })
    .eq("id", id)
    .eq("status", "setup"); // guard: only transition from setup

  if (error) throw new Error(error.message);
  revalidatePath("/workspaces");
  revalidatePath(`/workspaces/${id}`);
}

export async function deleteWorkspace(id: string) {
  await requireAuth();
  const supabase = await createClient();
  const { error } = await supabase.from("workspaces").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/workspaces");
}

/** Every page that shows a site's status or its calendar. */
function revalidateSite(id: string) {
  revalidatePath("/workspaces");
  revalidatePath(`/workspaces/${id}`);
  revalidatePath("/content");
  revalidatePath("/dashboard");
}

/**
 * Pause one site. The behaviour is lib/workspaces/pause.ts, shared with the
 * agent API's POST /workspaces/{id}/pause; this is its server-action door.
 * Nothing is written or published for a paused site until Resume.
 */
export async function pauseWorkspace(id: string): Promise<PausedMeta> {
  const { agencyId, user } = await requireAuth();
  const supabase = await createClient();
  const { meta } = await pauseWorkspaceCore(supabase, agencyId, id, user.id);
  revalidateSite(id);
  return meta;
}

/**
 * Resume a site paused by hand: status back, calendar re-planned from today.
 * Same core as the agent API's POST /workspaces/{id}/resume.
 */
export async function resumeWorkspace(id: string): Promise<{ status: string; replanned: number | null }> {
  const { agencyId } = await requireAuth();
  const supabase = await createClient();
  const { status, replanned } = await resumeWorkspaceCore(supabase, agencyId, id);
  revalidateSite(id);
  return { status, replanned };
}
