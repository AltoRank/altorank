"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { DEFAULT_SCOPES, expiryFromDays, generateApiKey } from "@/lib/agent/api-keys";

// ---------------------------------------------------------------------------
// API keys for the agent surface: create once, revoke forever
// ---------------------------------------------------------------------------
//
// Owner/admin only, like rotating the legacy key. The full key value leaves
// this function exactly once, in the return value; the row keeps its hash.

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(80),
  expires_in_days: z.union([z.literal("never"), z.coerce.number().int().positive().max(3650)]),
});

export type CreatedApiKey = {
  id: string;
  name: string;
  /** Shown once. Not stored. */
  key: string;
  prefix: string;
  expires_at: string | null;
};

export async function createApiKey(formData: FormData): Promise<CreatedApiKey> {
  const { user, agencyId } = await requireAuth(["owner", "admin"]);
  const parsed = createSchema.parse({
    name: formData.get("name"),
    expires_in_days: formData.get("expires_in_days") ?? "never",
  });

  const generated = generateApiKey();
  const expiresAt = expiryFromDays(parsed.expires_in_days === "never" ? null : parsed.expires_in_days);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      agency_id: agencyId,
      name: parsed.name,
      key_hash: generated.hash,
      prefix: generated.prefix,
      scopes: [...DEFAULT_SCOPES],
      expires_at: expiresAt,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(error?.message ?? "Could not create the API key");
  revalidatePath("/settings/api-keys");

  return { id: data.id, name: parsed.name, key: generated.key, prefix: generated.prefix, expires_at: expiresAt };
}

export async function revokeApiKey(id: string): Promise<void> {
  const { agencyId } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("agency_id", agencyId)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/api-keys");
}
