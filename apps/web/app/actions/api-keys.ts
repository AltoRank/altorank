"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { sessionTrialGate } from "@/lib/billing/body-lock";
import { trialRefusal } from "@/lib/billing/trial-refusal";
import { DEFAULT_SCOPES, expiryFromDays, generateApiKey, type ApiKeyScope } from "@/lib/agent/api-keys";
import { announceApiKeyCreated } from "@/lib/email/account-events";
import { actorName } from "@/lib/email/approval-events";

// ---------------------------------------------------------------------------
// API keys for the agent surface: create once, revoke forever
// ---------------------------------------------------------------------------
//
// Owner/admin only, like rotating the legacy key. The full key value leaves
// this function exactly once, in the return value; the row keeps its hash.
//
// The row is written with the service role, after the checks below, and a
// client token can no longer insert one (migration 099). The table used to
// take inserts from any owner or admin over PostgREST, and the hash is a
// plain sha256, so a person could choose their own key - and name any user
// as its creator, which is whose address the agent API asks the trial gate
// and the operator list about (lib/agent/body-lock.ts).
//
// An account that has not started its trial gets no key. No trial means no
// dashboard, and the agent API is the dashboard by another door.

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(80),
  expires_in_days: z.union([z.literal("never"), z.coerce.number().int().positive().max(3650)]),
  /** The "write" scope is opt-in: a key that can move the plan or edit drafts is a different thing to hand out. */
  allow_write: z.boolean().default(false),
});

export type CreatedApiKey = {
  id: string;
  name: string;
  /** Shown once. Not stored. */
  key: string;
  prefix: string;
  expires_at: string | null;
  scopes: string[];
};

export async function createApiKey(formData: FormData): Promise<CreatedApiKey> {
  const { user, accountId } = await requireAuth(["owner", "admin"]);
  const parsed = createSchema.parse({
    name: formData.get("name"),
    expires_in_days: formData.get("expires_in_days") ?? "never",
    allow_write: formData.get("allow_write") === "on",
  });
  const scopes: ApiKeyScope[] = parsed.allow_write ? [...DEFAULT_SCOPES, "write"] : [...DEFAULT_SCOPES];
  if ((await sessionTrialGate(accountId, user.email ?? null)) === "gated") throw new Error(trialRefusal("spend"));

  const generated = generateApiKey();
  const expiresAt = expiryFromDays(parsed.expires_in_days === "never" ? null : parsed.expires_in_days);

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      account_id: accountId,
      name: parsed.name,
      key_hash: generated.hash,
      prefix: generated.prefix,
      scopes,
      expires_at: expiresAt,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(error?.message ?? "Could not create the API key");

  // A credential that works without a password and without a browser. The
  // owners and admins who did not create it are exactly who should hear about
  // it - and the one who did gets the record. The value is not in the email.
  await announceApiKeyCreated({
    accountId,
    keyId: data.id as string,
    keyName: parsed.name,
    prefix: generated.prefix,
    createdBy: actorName(user),
    canWrite: parsed.allow_write,
    expiresAt,
  });

  revalidatePath("/settings/api-keys");

  return { id: data.id, name: parsed.name, key: generated.key, prefix: generated.prefix, expires_at: expiresAt, scopes };
}

export async function revokeApiKey(id: string): Promise<void> {
  const { accountId } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("account_id", accountId)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/api-keys");
}
