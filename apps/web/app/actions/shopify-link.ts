"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canAddWorkspace } from "@/lib/team/access";
import { insertWorkspaceAsServer, ADD_SITE_ROLE_MESSAGE } from "@/lib/workspaces/insert";
import { getWorkspaceAllowance, workspaceLimitMessage } from "@/lib/billing/workspaces";
import { generateIndexNowKey } from "@/lib/seo/indexing";
import { linkStore, readLinkSource, sourceRetirementBlocker, verifyLinkToken } from "@/lib/shopify/link";

export type LinkShopifyResult = { ok: true; domain: string } | { ok: false; error: string };

/**
 * Move a Shopify store onto the signed-in person's account (lib/shopify/link.ts).
 * `workspaceId` is one of their sites, or "new" to add the store's domain as
 * a site of its own, under the same allowance as Add workspace.
 */
export async function linkShopifyStore(token: string, workspaceId: string): Promise<LinkShopifyResult> {
  const { user, accountId, role } = await requireAuth();
  if (!canAddWorkspace(role)) return { ok: false, error: "Only an owner or admin of this account can connect a store to it." };

  const verified = verifyLinkToken(token);
  if (!verified.ok) return { ok: false, error: verified.reason };

  const db = createServiceClient();
  const source = await readLinkSource(db, verified.payload);
  if ("error" in source) return { ok: false, error: source.error };
  const blocker = await sourceRetirementBlocker(db, source);
  if (blocker) return { ok: false, error: blocker };

  const asCaller = await createClient();
  let targetWorkspaceId: string;
  let domain: string;
  if (workspaceId === "new") {
    if (!source.domain) return { ok: false, error: "The store's domain is unknown. Choose one of your sites instead." };
    const allowance = await getWorkspaceAllowance(asCaller, accountId, user.email);
    if (allowance.remaining !== null && allowance.remaining <= 0) return { ok: false, error: workspaceLimitMessage(allowance) };
    const inserted = await insertWorkspaceAsServer(asCaller, user.id, accountId, {
      name: source.domain,
      domain: source.domain,
      initials: source.domain.slice(0, 2).toUpperCase(),
      color: "av-c1",
      indexnow_key: generateIndexNowKey(),
    });
    if (!inserted.ok) return { ok: false, error: inserted.error === ADD_SITE_ROLE_MESSAGE ? inserted.error : `Could not add the site: ${inserted.error}` };
    targetWorkspaceId = inserted.id;
    domain = source.domain;
  } else {
    // Through the person's own client: RLS says whether this site is theirs,
    // and the account check pins it to the account they are signed in to.
    const { data: site } = await asCaller
      .from("workspaces")
      .select("id, domain, account_id")
      .eq("id", workspaceId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (!site) return { ok: false, error: "Choose one of your sites." };
    targetWorkspaceId = site.id as string;
    domain = (site.domain as string | null) ?? "";
  }

  const result = await linkStore(db, source, { accountId, workspaceId: targetWorkspaceId });
  if (!result.ok) return result;
  revalidatePath("/connect");
  return { ok: true, domain };
}
