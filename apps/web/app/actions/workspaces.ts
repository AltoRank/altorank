"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ensureAgency } from "@/lib/queries/agency";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { generateIndexNowKey } from "@/lib/seo/indexing";

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
  domain: z.string().optional(),
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

  const agencyId = await ensureAgency(user.id, user.user_metadata ?? {});

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

export async function activateWorkspace(id: string) {
  await requireAuth();
  const supabase = await createClient();
  // Activation is the opt-in. It used to set status only, so a workspace
  // activated by hand never got a draft: auto_generate stayed false and the
  // cron skipped it for ever, while the overview showed four zeros and
  // nothing else (2026-09-02). Two drafts a week is the default cadence.
  const { error } = await supabase
    .from("workspaces")
    .update({ status: "on", auto_generate: true, auto_generate_weekly_limit: 2 })
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
