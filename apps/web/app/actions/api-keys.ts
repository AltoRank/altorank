"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { isSiteLimited, LIMITED_NO_KEYS } from "@/lib/team/access";
import { readMemberSites } from "@/lib/team/member-sites";
import { sessionTrialGate } from "@/lib/billing/body-lock";
import { trialRefusal } from "@/lib/billing/trial-refusal";
import { BLOG_SCOPE, DEFAULT_SCOPES, expiryFromDays, generateApiKey, type ApiKeyScope } from "@/lib/agent/api-keys";
import { isMissingColumn } from "@/lib/supabase/missing-column";
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
//
// A member limited to some sites gets no key either: a key acts for the whole
// account (lib/agent/auth.ts resolves it to an account, not to sites), so it
// would reach the sites they were kept out of. Migration 111 refuses the row
// in the database as well.
//
// Two kinds of key (migration 118). An agent key acts for the account through
// the agent API and the hosted MCP. A blog key is what goes into a customer
// site's environment for @altorank/next-blog: scopes `{blog}`, one site, read
// its live articles through /api/blog/v1, refused by the agent API. It is
// still made here, by an owner or admin with every site, like any key.

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(80),
  expires_in_days: z.union([z.literal("never"), z.coerce.number().int().positive().max(3650)]),
  /** The "write" scope is opt-in: a key that can move the plan or edit drafts is a different thing to hand out. */
  allow_write: z.boolean().default(false),
  kind: z.enum(["agent", "blog"]).default("agent"),
  /** A blog key's site. Required for, and only read for, a blog key. */
  workspace_id: z.string().uuid().optional(),
});

const BLOG_KEYS_NOT_READY =
  "Blog keys need a database update that has not been applied yet. Try again later, or use an agent key for now.";

export type CreatedApiKey = {
  id: string;
  name: string;
  /** Shown once. Not stored. */
  key: string;
  prefix: string;
  expires_at: string | null;
  scopes: string[];
  /** A blog key's site, for the env lines shown with the key. */
  workspace_id: string | null;
};

export async function createApiKey(formData: FormData): Promise<CreatedApiKey> {
  const { user, accountId } = await requireAuth(["owner", "admin"]);
  if (isSiteLimited(await readMemberSites(await createClient(), accountId, user.id))) throw new Error(LIMITED_NO_KEYS);
  const parsed = createSchema.parse({
    name: formData.get("name"),
    expires_in_days: formData.get("expires_in_days") ?? "never",
    allow_write: formData.get("allow_write") === "on",
    kind: formData.get("kind") ?? "agent",
    workspace_id: formData.get("workspace_id") || undefined,
  });
  const blog = parsed.kind === "blog";
  const scopes: string[] = blog
    ? [BLOG_SCOPE]
    : parsed.allow_write
      ? ([...DEFAULT_SCOPES, "write"] satisfies ApiKeyScope[])
      : [...DEFAULT_SCOPES];
  if ((await sessionTrialGate(accountId, user.email ?? null)) === "gated") throw new Error(trialRefusal("spend"));

  const supabase = createServiceClient();

  // The site must be this account's. Read with the service role, so the
  // account filter here is the check (migration 118's trigger repeats it).
  let site: { id: string; domain: string } | null = null;
  if (blog) {
    if (!parsed.workspace_id) throw new Error("Choose the site this blog key reads.");
    const { data: ws } = await supabase
      .from("workspaces")
      .select("id, domain")
      .eq("id", parsed.workspace_id)
      .eq("account_id", accountId)
      .maybeSingle();
    if (!ws) throw new Error("That site is not on this account.");
    site = { id: ws.id as string, domain: ws.domain as string };
  }

  const generated = generateApiKey();
  const expiresAt = expiryFromDays(parsed.expires_in_days === "never" ? null : parsed.expires_in_days);

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
      ...(site ? { workspace_id: site.id } : {}),
    })
    .select("id")
    .single();

  if (site && isMissingColumn(error)) throw new Error(BLOG_KEYS_NOT_READY);
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
    canWrite: !blog && parsed.allow_write,
    expiresAt,
    ...(site ? { blogSite: site.domain } : {}),
  });

  revalidatePath("/settings/api-keys");

  return {
    id: data.id,
    name: parsed.name,
    key: generated.key,
    prefix: generated.prefix,
    expires_at: expiresAt,
    scopes,
    workspace_id: site?.id ?? null,
  };
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
