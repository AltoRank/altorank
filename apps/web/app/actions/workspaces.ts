"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ensureAgency } from "@/lib/queries/agency";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
  domain: z.string().optional(),
  plan: z.string().default("starter"),
  initials: z.string().max(2).default(""),
  color: z.string().default("av-c1"),
});

export async function createWorkspace(formData: FormData) {
  const supabase = await createClient();
  const parsed = createWorkspaceSchema.parse({
    name: formData.get("name"),
    domain: formData.get("domain"),
    plan: formData.get("plan"),
    initials: formData.get("initials") || (formData.get("name") as string).slice(0, 2).toUpperCase(),
    color: formData.get("color") || "av-c1",
  });

  // Get or create user's agency
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const agencyId = await ensureAgency(user.id, user.user_metadata ?? {});

  const { data, error } = await supabase
    .from("workspaces")
    .insert({ ...parsed, agency_id: agencyId })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  revalidatePath("/clients");
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
  revalidatePath("/clients");
  revalidatePath("/articles");
}

export async function activateWorkspace(id: string) {
  await requireAuth();
  const supabase = await createClient();
  const { error } = await supabase
    .from("workspaces")
    .update({ status: "on" })
    .eq("id", id)
    .eq("status", "setup"); // guard: only transition from setup

  if (error) throw new Error(error.message);
  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
}

export async function deleteWorkspace(id: string) {
  await requireAuth();
  const supabase = await createClient();
  const { error } = await supabase.from("workspaces").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/clients");
}
