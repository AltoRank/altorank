"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authErrorMessage } from "@/lib/auth/errors";
import { requireAuth } from "@/lib/auth/require-auth";
import { randomBytes } from "crypto";

export async function updateAgencyProfile(formData: FormData) {
  // Agency-level settings (incl. white-label branding / custom domain) are
  // owner/admin only — editors shouldn't be able to rebrand the agency.
  const { agencyId } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();

  const updates: Record<string, unknown> = {};
  const fields = ["name", "report_email", "custom_domain", "accent_color"];
  for (const field of fields) {
    const val = formData.get(field);
    if (val !== null) updates[field] = val;
  }

  const removeBranding = formData.get("remove_branding");
  if (removeBranding !== null) updates.remove_branding = removeBranding === "true";

  const { error } = await supabase
    .from("agencies")
    .update(updates)
    .eq("id", agencyId);

  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}

export async function rotateApiKey() {
  const { agencyId } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();

  const newKey = `fr_live_sk_${randomBytes(16).toString("hex")}`;

  const { error } = await supabase
    .from("agencies")
    .update({ api_key: newKey })
    .eq("id", agencyId);

  if (error) throw new Error(error.message);
  revalidatePath("/settings");
  return newKey;
}

/** Change the signed-in account's password. See components/dashboard/password-form.tsx. */
export async function changePassword(formData: FormData): Promise<{ error?: string }> {
  const password = formData.get("password") as string;
  const confirm = formData.get("confirm") as string;
  if (!password || password.length < 8) return { error: "Use at least 8 characters." };
  if (password !== confirm) return { error: "The two passwords do not match." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: authErrorMessage(error.message) };
  return {};
}
