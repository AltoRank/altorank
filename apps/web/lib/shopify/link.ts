import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptConfig, encryptConfig } from "@/lib/crypto";
import { shopAdminBase } from "./shop-domain";

/**
 * Attach a store installed from the Shopify App Store to an AltoRank account
 * the person already has, in place of the one the install made for it.
 *
 * Two proofs, never an email match (lib/shopify/provision.ts says why):
 *  1. A Shopify ID token: the embedded app asks /api/shopify/link-token for a
 *     signed link naming this store's installation and the account the
 *     install made.
 *  2. An AltoRank session: the link opens at the top level, where the person
 *     signs in as an owner or admin of the account that takes the store.
 *
 * The token is single-use by construction: it names the account the store is
 * attached to now, and linking moves the store off it, so the same link can
 * never move it twice.
 */

export const LINK_TTL_MS = 15 * 60 * 1000;

export interface LinkPayload {
  installationId: string;
  shop: string;
  /** The account the store is on when the link was issued. */
  fromAccountId: string;
  /** Epoch ms. */
  exp: number;
  nonce: string;
}

function linkSecret(): string | null {
  const secret = process.env.SHOPIFY_API_SECRET?.trim();
  return secret ? `altorank-shopify-link|${secret}` : null;
}

function mac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signLinkToken(
  claims: Omit<LinkPayload, "exp" | "nonce">,
  now: number = Date.now(),
): string | null {
  const secret = linkSecret();
  if (!secret) return null;
  const payload: LinkPayload = { ...claims, exp: now + LINK_TTL_MS, nonce: randomBytes(9).toString("base64url") };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

export type VerifiedLink = { ok: true; payload: LinkPayload } | { ok: false; reason: string };

export function verifyLinkToken(token: string | null | undefined, now: number = Date.now()): VerifiedLink {
  const secret = linkSecret();
  if (!secret) return { ok: false, reason: "Linking Shopify stores is not set up on this server." };
  const [body, sig] = (token ?? "").split(".");
  if (!body || !sig) return { ok: false, reason: "The link is incomplete. Open it again from AltoRank in your Shopify admin." };
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "The link's signature does not match. Open it again from AltoRank in your Shopify admin." };
  }
  let payload: LinkPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "The link is malformed." };
  }
  if (!(payload.exp > now)) return { ok: false, reason: "The link has expired. Open it again from AltoRank in your Shopify admin." };
  return { ok: true, payload };
}

/** Statuses that mean the install's own account already did real work. */
const SHIPPED = ["approved", "scheduled", "live"];

export interface LinkSource {
  installationId: string;
  shop: string;
  shopName: string | null;
  domain: string | null;
  fromAccountId: string;
  fromWorkspaceId: string | null;
}

/**
 * The store a verified link names, if the link still applies: the store is
 * still installed and still on the account the link was issued for.
 */
export async function readLinkSource(db: SupabaseClient, payload: LinkPayload): Promise<LinkSource | { error: string }> {
  const { data } = await db
    .from("shopify_installations")
    .select("id, shop_domain, shop_name, primary_domain, account_id, workspace_id, uninstalled_at")
    .eq("id", payload.installationId)
    .maybeSingle();
  if (!data || data.shop_domain !== payload.shop || data.uninstalled_at) {
    return { error: "This store is no longer installed. Install AltoRank from the Shopify App Store again." };
  }
  if (data.account_id !== payload.fromAccountId) {
    return { error: "This link was already used. Open AltoRank in your Shopify admin to see where the store is now." };
  }
  return {
    installationId: data.id as string,
    shop: data.shop_domain as string,
    shopName: (data.shop_name as string | null) ?? null,
    domain: (data.primary_domain as string | null) ?? null,
    fromAccountId: data.account_id as string,
    fromWorkspaceId: (data.workspace_id as string | null) ?? null,
  };
}

/**
 * Why the install's own account cannot simply be retired, or null. It can be
 * when nothing of value happened on it: no article approved or published, no
 * Shopify plan running, nobody else invited. Otherwise the two accounts hold
 * real history and merging them is a support job, not a click.
 */
export async function sourceRetirementBlocker(db: SupabaseClient, source: LinkSource): Promise<string | null> {
  const [{ data: account }, { count: shipped }, { count: members }] = await Promise.all([
    db.from("accounts").select("billing_provider, plan_status").eq("id", source.fromAccountId).maybeSingle(),
    db
      .from("articles")
      .select("id, workspaces!inner(account_id)", { count: "exact", head: true })
      .eq("workspaces.account_id", source.fromAccountId)
      .in("status", SHIPPED),
    db.from("account_members").select("id", { count: "exact", head: true }).eq("account_id", source.fromAccountId),
  ]);
  if (account?.billing_provider === "shopify" && ["active", "trialing"].includes(String(account.plan_status))) {
    return "This store already pays for AltoRank through Shopify. Email hello@altorank.co and we will move the plan and the store to your account.";
  }
  if ((shipped ?? 0) > 0) {
    return "Articles were already approved or published from this store's own AltoRank account. Email hello@altorank.co and we will merge the two accounts.";
  }
  if ((members ?? 0) > 1) {
    return "Other people were invited to this store's own AltoRank account. Email hello@altorank.co and we will merge the two accounts.";
  }
  return null;
}

export type LinkResult = { ok: true; workspaceId: string } | { ok: false; error: string };

/**
 * Move the store onto `target`. The caller has verified the link, the
 * person's session, their role on the target account, and that the target
 * site belongs to it.
 *
 * 1. The installation is moved with a compare-and-set on the account the link
 *    named: a second use of the same link, or a race with another, finds
 *    nothing to move.
 * 2. The target site gets the store's connection (blog and publish mode kept).
 *    A site already connected to a different Shopify store is refused.
 * 3. The install's own account, now empty of the store, is deleted, with its
 *    owner when that owner was the placeholder the install created.
 */
export async function linkStore(
  db: SupabaseClient,
  source: LinkSource,
  target: { accountId: string; workspaceId: string },
): Promise<LinkResult> {
  if (target.accountId === source.fromAccountId) return { ok: false, error: "The store is already on this account." };

  const { data: existing } = await db
    .from("workspace_integrations")
    .select("id, config")
    .eq("workspace_id", target.workspaceId)
    .eq("integration_id", "shopify")
    .maybeSingle();
  if (existing) {
    const cfg = decryptConfig(existing.config as Record<string, unknown>);
    const sameStore = (() => {
      try {
        return new URL(String(cfg.storeUrl)).host === source.shop;
      } catch {
        return false;
      }
    })();
    if (cfg.installationId !== source.installationId && !sameStore) {
      return { ok: false, error: "That site is already connected to a different Shopify store. Choose another site or add this store as a new one." };
    }
  }

  const { data: oldConn } = source.fromWorkspaceId
    ? await db
        .from("workspace_integrations")
        .select("config, publish_mode")
        .eq("workspace_id", source.fromWorkspaceId)
        .eq("integration_id", "shopify")
        .maybeSingle()
    : { data: null };
  const oldCfg = oldConn ? decryptConfig(oldConn.config as Record<string, unknown>) : {};

  const { data: moved } = await db
    .from("shopify_installations")
    .update({ account_id: target.accountId, workspace_id: target.workspaceId, updated_at: new Date().toISOString() })
    .eq("id", source.installationId)
    .eq("account_id", source.fromAccountId)
    .select("id");
  if (!moved?.length) return { ok: false, error: "This link was already used. Open AltoRank in your Shopify admin to see where the store is now." };

  const { error: connError } = await db.from("workspace_integrations").upsert(
    {
      workspace_id: target.workspaceId,
      integration_id: "shopify",
      config: encryptConfig({
        type: "shopify",
        storeUrl: shopAdminBase(source.shop),
        installationId: source.installationId,
        ...(oldCfg.blogId ? { blogId: oldCfg.blogId, blogHandle: oldCfg.blogHandle } : {}),
      }),
      publish_mode: (oldConn?.publish_mode as string | undefined) ?? "draft",
      connected_at: new Date().toISOString(),
      needs_reconnect: false,
      last_sync_error: null,
    },
    { onConflict: "workspace_id,integration_id" },
  );
  if (connError) {
    // Put the store back where it was, so it is never left on no site.
    await db
      .from("shopify_installations")
      .update({ account_id: source.fromAccountId, workspace_id: source.fromWorkspaceId })
      .eq("id", source.installationId);
    return { ok: false, error: `Could not connect the store to that site: ${connError.message}` };
  }

  await retireSourceAccount(db, source);
  return { ok: true, workspaceId: target.workspaceId };
}

async function retireSourceAccount(db: SupabaseClient, source: LinkSource): Promise<void> {
  const { data: owners } = await db.from("account_members").select("user_id").eq("account_id", source.fromAccountId);
  // Cascades to its site, that site's connection, drafts and runs.
  await db.from("accounts").delete().eq("id", source.fromAccountId);
  for (const row of owners ?? []) {
    const userId = row.user_id as string;
    const { count } = await db.from("account_members").select("id", { count: "exact", head: true }).eq("user_id", userId);
    if ((count ?? 0) > 0) continue;
    const { data } = await db.auth.admin.getUserById(userId);
    // Only the owner the install itself created, never a person.
    if (data?.user?.user_metadata?.shopify_shop === source.shop) await db.auth.admin.deleteUser(userId);
  }
}
